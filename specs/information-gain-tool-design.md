# Information Gain Tool — Design Spec

## Overview

A content enrichment tool on seoplus.dev/tools/ that refreshes articles by injecting data points extracted from a curated library of research reports. Users paste an article URL — the tool returns the original text side-by-side with an enriched version, where every injected fact links to its source report.

Built as an Astro page matching the existing seoplus.dev tool style, with a Cloudflare Pages Function backend and DeepSeek V4 Flash for LLM enrichment.

## Architecture

Single Pages Function endpoint (`functions/api/enrich.ts`) handles the full pipeline:

```
Browser (form) → POST /api/enrich → validate → fetch article → match data points → LLM enrichment → return JSON → browser renders side-by-side
```

### One-time pre-processing

Source reports in `reports/*.md` are processed once to extract discrete data points into `reports/data-points.json`. This is a build step, not runtime.

```json
{
  "fact": "Only 12% of content achieves an IGS above 0.7",
  "source": "searchbloom.com",
  "sourceFile": "/reports/searchbloom.md",
  "category": "statistic",
  "context": "Information Gain Score tiers"
}
```

### Request flow

| Step | Where | What |
|------|-------|------|
| Validate | Pages Function | Rate limit (10/hr/IP), word cap (5K), Turnstile token |
| Fetch | Pages Function | Proxy GET article URL, extract plain text |
| Match | Pages Function | Search data-points.json for relevant entries via keyword/similarity |
| Enrich | Pages Function | Send article + matched data points to DeepSeek V4 Flash, 10K token cap |
| Render | Browser | Side-by-side display with amber-highlighted injections, clickable source links |

### Security

- DeepSeek API key stored as Cloudflare secret, never sent to browser
- Turnstile on form submit
- Rate limiting enforced in the Function
- Article fetch proxied through backend (no CORS issues, no client-side URL exposure)

## Report Types

Two distinct categories of reports in this project:

| Type | Location | Purpose | Used at... |
|------|----------|---------|------------|
| **Methodology playbook** | Root: `Information Gain Research Report.md` | Defines *how* enrichment works — rules for finding opportunities, the 5-to-7 Rule, GEO tactics, citation frameworks. Informs the system prompt design. | Design time only |
| **Data source reports** | `reports/*.md` + `reports/data-points.json` | Contain extractable facts, statistics, case studies. These are what the tool injects into articles. | Runtime (pre-filtered matches sent to LLM) |

The methodology report is never sent at runtime — it shapes the system prompt once, not per request.

## Page Layout

Matches existing seoplus.dev tool pattern (entity-gap-analyzer, meta-tag-generator):

- **Header**: Centered title ("Information Gain Tool") + one-line description, amber bottom border
- **Form card**: `bg-cream-100 dark:bg-warm-850`, rounded-lg, shadow-sm, `p-6 sm:p-10`
  - Article URL input (required)
  - Turnstile widget
  - Submit button (full-width amber, "Run Enrichment →")
  - Info text: rate limit, word cap, token budget, model name
- **Results area** (appears below form card after completion):
  - Two-column layout: Original (left) / Enriched (right)
  - Amber background highlights on injected data points
  - Each injection: source filename linked to `/reports/<file>.md`
  - Responsive: stacks vertically on mobile
- **Max content width**: `max-w-4xl` (896px), same as existing tools

## Form Fields

| Field | Type | Required |
|-------|------|----------|
| Article URL | `url` input | Yes |
| Turnstile | Cloudflare Turnstile widget | Yes |

No provider/model selector — DeepSeek V4 Flash is baked in. No API key field — key is a Cloudflare secret.

## API Contract

### Request

```
POST /api/enrich
Content-Type: application/json

{
  "url": "https://example.com/article",
  "turnstileToken": "cf-turnstile-response-token"
}
```

### Success Response

```json
{
  "original": "Plain text of the article",
  "enriched": "Enriched text with [IG]...[\\IG] markers around injections",
  "injections": [
    {
      "fact": "Only 12% of content achieves an IGS above 0.7",
      "source": "searchbloom.com",
      "sourceFile": "/reports/searchbloom.md",
      "position": 467
    }
  ]
}
```

The `[IG]...[\\IG]` markers allow the JS to parse exact injection positions without requiring the LLM to return structured JSON (unreliable for inline text). The browser strips markers and renders amber highlights with source links.

### Error Responses

| Error | HTTP | Body |
|-------|------|------|
| Invalid URL | 400 | `{ "error": "INVALID_URL" }` |
| Article > 5K words | 400 | `{ "error": "WORD_LIMIT", "wordCount": 6123 }` |
| Rate limited | 429 | `{ "error": "RATE_LIMIT", "retryAfter": "47 minutes" }` |
| Token budget exceeded | 413 | `{ "error": "TOKEN_BUDGET" }` |
| Turnstile failed | 400 | `{ "error": "TURNSTILE_FAILED" }` |
| Fetch timeout (10s) | 502 | `{ "error": "FETCH_TIMEOUT" }` |
| Fetch blocked | 502 | `{ "error": "FETCH_BLOCKED" }` |

## Guardrails

| Guardrail | Value | Enforcement |
|-----------|-------|-------------|
| Rate limit | 10 requests/hour per IP | Pages Function checks + sets header |
| Word cap | 5,000 words | Pages Function validates post-fetch |
| Token budget | 10,000 tokens total (input + output) | Pages Function rejects if exceeded |
| Turnstile | Required before submit | Browser + server-side verification |
| Fetch timeout | 10 seconds | Pages Function abort controller |

## LLM Prompt Design

The Pages Function sends to DeepSeek V4 Flash:

1. **System prompt**: Instructions for the enrichment task — inject relevant data points where they naturally fit, use `[IG]...[\\IG]` markers, do not fabricate data, only use provided data points
2. **Article text**: The fetched article content
3. **Available data points**: Pre-filtered relevant entries from `data-points.json`

Token allocation: ~4K article, ~1K data points, ~500 prompt overhead, ~4K output. Hard cap at 10K.

## File Structure

```
information-gain/              (this repo — the tool page + function)
├── specs/
│   └── information-gain-tool-design.md
├── reports/                   (source report markdown files)
│   ├── data-points.json       (pre-extracted data points)
│   └── *.md                   (source reports, linked from injections)
├── functions/
│   └── api/
│       └── enrich.ts          (Pages Function — the full pipeline)
└── ...                        (Astro page: src/pages/tools/information-gain.astro)

seoplus/                       (existing Astro site repo)
├── src/pages/tools/
│   └── information-gain.astro (the tool page)
└── public/reports/            (symlink or copy of reports/ for static serving)
```

## Dependencies

- **Astro v4** (existing site framework)
- **Tailwind CSS** (existing site styling)
- **Vanilla JS** (client interactivity, no framework)
- **Cloudflare Pages Functions** (backend)
- **Cloudflare Turnstile** (bot prevention)
- **DeepSeek V4 Flash API** (LLM enrichment)

## Out of Scope

- User-uploaded reports
- Batch processing
- CMS integration
- Scheduled enrichment
- Live web search
- Preview/edit step before final output
- Custom provider/model selection (baked-in DeepSeek)
