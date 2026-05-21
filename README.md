# Information Gain Tool

Content enrichment tool for seoplus.dev. Injects data points from research reports into articles.

## Setup

1. Install dependencies: `npm install`
2. Extract data points from reports: `DEEPSEEK_API_KEY=sk-... npx tsx scripts/extract-data-points.ts`
3. Set Cloudflare Pages secrets:
   - `wrangler secret put DEEPSEEK_API_KEY`
   - `wrangler secret put TURNSTILE_SECRET_KEY`
4. Set environment variable in Cloudflare Pages Dashboard:
   - `PUBLIC_TURNSTILE_SITE_KEY` = your Turnstile site key
5. Deploy: `wrangler pages deploy`

## Architecture

- `reports/` — Source research PDFs + extracted `data-points.json`
- `scripts/extract-data-points.ts` — One-time PDF → data point extraction via DeepSeek
- `functions/api/enrich.ts` — Pages Function: validate → fetch → match → enrich
- `src/pages/tools/information-gain.astro` — Tool page (Astro)
- `public/scripts/information-gain.js` — Client-side vanilla JS
