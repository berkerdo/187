#!/usr/bin/env python3
import json
import sys
import time
from typing import Iterable, List

from pytrends.request import TrendReq


def chunked(iterable: List[str], size: int) -> Iterable[List[str]]:
  for index in range(0, len(iterable), size):
    yield iterable[index:index + size]


def main() -> None:
  payload = json.load(sys.stdin)
  keywords = payload.get('keywords', [])
  if not keywords:
    json.dump({'results': []}, sys.stdout)
    return

  lookback_months = int(payload.get('lookbackMonths', 12))
  geo = payload.get('geo', '')
  batch_size = max(1, int(payload.get('batchSize', 5)))
  sleep_ms = max(0, int(payload.get('sleepBetweenBatchesMs', 1000)))
  tz = int(payload.get('tz', 360))
  proxy = payload.get('proxy')

  timeframe = f"today {lookback_months}-m" if lookback_months <= 36 else 'today 5-y'

  requests_args = {}
  if proxy:
    requests_args['proxies'] = {'https': proxy, 'http': proxy}

  pytrends = TrendReq(hl='en-US', tz=tz, retries=2, backoff_factor=0.5, requests_args=requests_args)

  results = []

  for batch in chunked(keywords, batch_size):
    pytrends.build_payload(batch, cat=0, timeframe=timeframe, geo=geo)
    data = pytrends.interest_over_time()
    for keyword in batch:
      if keyword not in data:
        results.append({'keyword': keyword, 'interest': None, 'series': []})
        continue
      series = data[keyword].dropna().tolist()
      if 'isPartial' in data.columns:
        series = data[keyword][data['isPartial'] == False].dropna().tolist() or series
      interest = None
      if series:
        interest = sum(series) / len(series)
      results.append({'keyword': keyword, 'interest': interest, 'series': series})
    if sleep_ms > 0:
      time.sleep(sleep_ms / 1000)

  json.dump({'results': results}, sys.stdout)


if __name__ == '__main__':
  main()
