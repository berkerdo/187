import { randomUUID } from 'node:crypto';

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\-']*/gu;
const SPACE_PATTERN = /\s+/g;
const NON_WORD_PATTERN = /[^\p{L}\p{N}\s\-']/gu;

export interface PhraseExtractionOptions {
  stopwords?: Set<string>;
  minTokens?: number;
  maxTokens?: number;
  minCharacters?: number;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(SPACE_PATTERN, ' ').trim();
}

export function normalizeKeyword(value: string): string | null {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) {
    return null;
  }

  const cleaned = trimmed.replace(NON_WORD_PATTERN, ' ');
  const collapsed = normalizeWhitespace(cleaned);
  if (!collapsed) {
    return null;
  }

  const normalized = collapsed.normalize('NFKC').toLowerCase();
  if (normalized.length < 2) {
    return null;
  }

  return normalized;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.normalize('NFKC').toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = WORD_PATTERN.exec(normalized)) !== null) {
    const token = match[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!token) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

export function extractPhrases(text: string, options: PhraseExtractionOptions = {}): string[] {
  const stopwords = options.stopwords ?? new Set<string>();
  const minTokens = Math.max(1, options.minTokens ?? 1);
  const maxTokens = Math.max(minTokens, options.maxTokens ?? Math.max(minTokens, 3));
  const minCharacters = Math.max(2, options.minCharacters ?? 2);

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const phrases = new Set<string>();

  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = minTokens; length <= maxTokens; length += 1) {
      const end = start + length;
      if (end > tokens.length) {
        break;
      }

      const slice = tokens.slice(start, end);
      if (slice.length < minTokens) {
        continue;
      }

      const hasOnlyStopwords = slice.every((token) => stopwords.has(token));
      if (hasOnlyStopwords) {
        continue;
      }

      const phrase = slice.join(' ');
      if (phrase.length < minCharacters) {
        continue;
      }

      phrases.add(phrase);
    }
  }

  return Array.from(phrases.values());
}

export function generateDeterministicId(): string {
  return randomUUID();
}
