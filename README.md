# Etsy Keyword Discovery Pipeline

This repository hosts a seedless keyword discovery and scoring system for Etsy inspired by the product requirements document. The
codebase is split between a TypeScript orchestrator and supporting Python utilities for HTML parsing and analytics.

## Getting started

1. Install Node.js 18+ and Python 3.11+.
2. Install Node dependencies:

   ```bash
   npm install
   ```

3. Install Playwright browser binaries (optional now, required before crawling):

   ```bash
   npx playwright install
   ```

4. Install Python dependencies:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r python/requirements.txt
   ```

5. Copy `.env` (or edit the checked-in stub) and update the secrets.
6. Adjust the default configuration in `configs/settings.yaml`.

## Project structure

```
configs/            # YAML configuration files
src/                # TypeScript orchestrator source
  config/           # Settings and environment helpers
  utils/            # Shared utilities
python/             # Python helper environment (requirements only for now)
data/               # SQLite database and caches (gitignored)
outputs/            # Generated CSV exports (gitignored)
```

Run the bootstrap script with:

```bash
npm run dev
```

This will load the configuration, ensure the data/output directories exist, and log a bootstrap message. The actual crawling,
parsing, and scoring logic will be added in subsequent tasks.
