# Architecture — Information Gain Tool

## Stack Summary

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | Astro (static site, part of seoplus.dev) | v4.x |
| Language | TypeScript | |
| Styling | Tailwind CSS | |
| Client scripting | Vanilla JS (no framework) | |
| Backend functions | Cloudflare Pages Functions | |
| LLM integration | Client-side (browser → provider API directly) | |
| Database | None — static Markdown files in `reports/` | |
| Package manager | npm | |
| Deployment | Cloudflare Pages (alongside seoplus.dev) | |

## Project Structure

```
information-gain/
├── PRD.md
├── ARCHITECTURE.md
├── UI_UX.md
├── STATE.md
├── BRAINSTORM.md
├── reports/                    # Curated library of source reports (Markdown)
│   ├── report-1.md
│   ├── report-2.md
│   └── ...
├── src/
│   ├── pages/
│   │   └── tools/
│   │       └── information-gain.astro   # Tool page (Astro component)
│   └── lib/
│       ├── fetch-article.ts             # Proxy fetch via Pages Function
│       ├── search-reports.ts            # Report matching logic
│       └── enrich.ts                    # LLM-side enrichment logic (client)
├── functions/
│   └── api/
│       ├── fetch-article.ts             # Pages Function: proxy article fetch
│       └── search-reports.ts            # Pages Function: search/return reports
└── public/
    └── scripts/
        └── information-gain.js          # Client-side vanilla JS
```

## Data Flow

```
User pastes URL
    │
    ▼
Browser calls Pages Function `api/fetch-article` (bypass CORS)
    │
    ▼
Browser sends article + relevant reports to chosen LLM provider
    │
    ▼
LLM returns enriched version with source citations
    │
    ▼
UI renders original vs. enriched side-by-side with source links
```

## Key Design Decisions

1. **LLM calls are client-side** — API keys never leave the browser. Matches existing seoplus.dev tool security model.
2. **Pages Function proxies article fetching** — avoids CORS issues when fetching arbitrary article URLs.
3. **Pages Function serves reports** — pre-filters relevant reports by searching Markdown content server-side before returning matches to the client, reducing token waste.
4. **Reports are static Markdown files** — no database. Reports live in `reports/` and are committed to the repo. Conversion from source formats to Markdown happens during report ingestion.
5. **Vanilla JS for interactivity** — no React/Vue/Svelte. Consistent with existing tools on seoplus.dev.

## API Keys & Security

- LLM provider API keys are entered by the user in the browser form
- Keys are stored only in browser memory (never persisted, never sent to Cloudflare)
- Pages Functions do not require or handle API keys
- Article proxy endpoint (`api/fetch-article`) accepts only the target URL, returns raw HTML/text
