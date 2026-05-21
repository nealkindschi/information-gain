# Information Gain Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a serverless content enrichment tool — Astro page + Cloudflare Pages Function that fetches an article, matches it against pre-extracted data points from research reports, enriches it via DeepSeek V4 Flash, and renders a side-by-side comparison with source links.

**Architecture:** Single Pages Function (`functions/api/enrich.ts`) handles validate → fetch → match → enrich → return. Reports are pre-processed once into `reports/data-points.json` via a build script. The Astro page is a vanilla JS form with Turnstile that POSTs to the function and renders the result.

**Tech Stack:** Astro v4, TypeScript, Tailwind CSS, Vanilla JS (client), Cloudflare Pages Functions, Cloudflare Turnstile, DeepSeek V4 Flash API, Node.js (extraction script)

---

## File Map

| File | Purpose |
|------|---------|
| `reports/data-points.json` | Pre-extracted data points from source reports |
| `scripts/extract-data-points.ts` | One-time script: reads `reports/*.md`, calls LLM to extract facts, writes JSON |
| `functions/api/enrich.ts` | Pages Function: validate → fetch article → match data points → enrich via LLM → return |
| `src/pages/tools/information-gain.astro` | Tool page: form (URL + Turnstile) + results area |
| `public/scripts/information-gain.js` | Client-side vanilla JS: form handling, API call, rendering side-by-side results |

---

### Task 1: Project Scaffold and Reports Directory

**Files:**
- Create: `reports/data-points.json`
- Create: `scripts/extract-data-points.ts` (empty placeholder)
- Create: `functions/api/enrich.ts` (empty placeholder)

- [ ] **Step 1: Create the reports directory and seed data-points.json**

```bash
mkdir -p reports scripts functions/api
```

- [ ] **Step 2: Write initial empty data-points.json**

Write `reports/data-points.json`:

```json
[]
```

- [ ] **Step 3: Create placeholder files for upcoming tasks**

Write `scripts/extract-data-points.ts`:

```typescript
// Placeholder — implementation in Task 2
```

Write `functions/api/enrich.ts`:

```typescript
// Placeholder — implementation in Tasks 3-6
```

- [ ] **Step 4: Commit**

```bash
git add reports/ scripts/ functions/
git commit -m "feat: scaffold reports, scripts, and functions directories"
```

---

### Task 2: Data Point Extraction Script

**Files:**
- Modify: `scripts/extract-data-points.ts`
- Modify: `reports/data-points.json`

- [ ] **Step 1: Write the extraction script**

Write `scripts/extract-data-points.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

const REPORTS_DIR = path.resolve("reports");
const OUTPUT = path.resolve("reports/data-points.json");
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY environment variable required");
  process.exit(1);
}

interface DataPoint {
  fact: string;
  source: string;
  sourceFile: string;
  category: string;
  context: string;
}

const SYSTEM_PROMPT = `You are a data extraction assistant. Given a research report in Markdown, extract every discrete, citable fact, statistic, case study result, and named insight.

Return a JSON array of objects with these fields:
- fact: The exact fact or data point as a quoted statement (e.g. "Only 12% of content achieves an IGS above 0.7")
- source: The domain or publication name where this fact originated (e.g. "searchbloom.com")
- sourceFile: The relative path to the source report (e.g. "/reports/searchbloom.md")
- category: One of "statistic", "case_study", "definition", "framework", "expert_quote", "benchmark"
- context: A short phrase describing what topic/section this fact relates to

Only include specific, citable facts. Do NOT extract narrative prose, opinion without data, or vague generalities. Each fact must be verifiable and attributable.`;

async function extractFromReport(content: string, filename: string): Promise<DataPoint[]> {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Source file: ${filename}\n\n${content}` },
      ],
      max_tokens: 8000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    choices: [{ message: { content: string } }];
  };
  const parsed = JSON.parse(data.choices[0].message.content);
  return parsed.data_points as DataPoint[];
}

async function main() {
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".md"));

  if (files.length === 0) {
    console.log("No report markdown files found in reports/");
    process.exit(0);
  }

  const allDataPoints: DataPoint[] = [];

  for (const file of files) {
    console.log(`Processing: ${file}`);
    const content = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
    const sourceFile = `/reports/${file}`;

    try {
      const points = await extractFromReport(content, sourceFile);
      console.log(`  Extracted ${points.length} data points`);
      allDataPoints.push(...points);
    } catch (err) {
      console.error(`  Failed to process ${file}: ${err}`);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(allDataPoints, null, 2));
  console.log(`\nWrote ${allDataPoints.length} total data points to ${OUTPUT}`);
}

main().catch(console.error);
```

- [ ] **Step 2: Run the script to verify it works (requires DEEPSEEK_API_KEY in env)**

```bash
npx tsx scripts/extract-data-points.ts
```

Expected: Should read any `.md` files in `reports/`, call DeepSeek, and populate `reports/data-points.json`.

- [ ] **Step 3: Commit**

```bash
git add scripts/extract-data-points.ts reports/data-points.json
git commit -m "feat: add data point extraction script from reports"
```

---

### Task 3: Pages Function — Validation Layer

**Files:**
- Modify: `functions/api/enrich.ts`

- [ ] **Step 1: Write the validation logic**

Write `functions/api/enrich.ts`:

```typescript
interface EnrichRequest {
  url: string;
  turnstileToken: string;
}

interface EnrichResponse {
  original: string;
  enriched: string;
  injections: Array<{
    fact: string;
    source: string;
    sourceFile: string;
    position: number;
  }>;
}

interface ErrorResponse {
  error: string;
  wordCount?: number;
  retryAfter?: string;
}

type RateLimitStore = Map<string, { count: number; resetAt: number }>;

// Env bindings are available via context.env in onRequest

// Rate limit store lives in module scope (per-isolate memory in Cloudflare)
const rateLimitStore: RateLimitStore = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_WORDS = 5000;
const MAX_TOKENS = 10000;
const FETCH_TIMEOUT_MS = 10000;

function getIP(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: string } {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT) {
    const minutesLeft = Math.ceil((entry.resetAt - now) / 60_000);
    return {
      allowed: false,
      retryAfter: `${minutesLeft} minutes`,
    };
  }

  entry.count++;
  return { allowed: true };
}

async function verifyTurnstile(token: string, ip: string, secret: string): Promise<boolean> {
  const formData = new FormData();
  formData.append("secret", secret);
  formData.append("response", token);
  formData.append("remoteip", ip);

  const result = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: formData },
  );

  const outcome = (await result.json()) as { success: boolean };
  return outcome.success;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isValidURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildError(status: number, body: ErrorResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Write the exported `onRequest` handler with validation**

Append to `functions/api/enrich.ts`:

```typescript
export const onRequest: PagesFunction = async (context) => {
  if (context.request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: EnrichRequest;
  try {
    body = await context.request.json();
  } catch {
    return buildError(400, { error: "INVALID_JSON" });
  }

  const ip = getIP(context.request);

  // 1. Rate limit check
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return buildError(429, {
      error: "RATE_LIMIT",
      retryAfter: rateCheck.retryAfter,
    });
  }

  // 2. URL validation
  if (!body.url || !isValidURL(body.url)) {
    return buildError(400, { error: "INVALID_URL" });
  }

  // 3. Turnstile verification
  if (!body.turnstileToken) {
    return buildError(400, { error: "TURNSTILE_MISSING" });
  }

  const turnstileValid = await verifyTurnstile(body.turnstileToken, ip, context.env.TURNSTILE_SECRET_KEY);
  if (!turnstileValid) {
    return buildError(400, { error: "TURNSTILE_FAILED" });
  }

  // 4. Fetch article (Task 4 continues here)
  // 5. Match data points (Task 5 continues here)
  // 6. Enrich via LLM (Task 6 continues here)
  // 7. Return response (Task 6 continues here)

  // Placeholder — will be replaced in subsequent tasks
  return new Response(JSON.stringify({ status: "validation passed" }), {
    headers: { "Content-Type": "application/json" },
  });
};
```

- [ ] **Step 3: Commit**

```bash
git add functions/api/enrich.ts
git commit -m "feat: add Pages Function validation layer (rate limit, Turnstile, URL)"
```

---

### Task 4: Pages Function — Article Fetching

**Files:**
- Modify: `functions/api/enrich.ts`

- [ ] **Step 1: Add article fetching function**

Insert after the `isValidURL` function in `functions/api/enrich.ts`:

```typescript
async function fetchArticle(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; InformationGainBot/1.0; +https://seoplus.dev/tools/information-gain)",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Extract text content from HTML
    const text = extractTextFromHTML(html);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTextFromHTML(html: string): string {
  // Remove scripts, styles, and HTML tags
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped;
}
```

- [ ] **Step 2: Integrate fetching into the handler**

Replace the placeholder comment block after Turnstile verification in the `onRequest` function with:

```typescript
  // 4. Fetch article
  let articleText: string;
  try {
    articleText = await fetchArticle(body.url);
  } catch (err) {
    return buildError(502, { error: "FETCH_FAILED" });
  }

  // 5. Word count check
  const wordCount = countWords(articleText);
  if (wordCount > MAX_WORDS) {
    return buildError(400, {
      error: "WORD_LIMIT",
      wordCount,
    });
  }
```

- [ ] **Step 3: Commit**

```bash
git add functions/api/enrich.ts
git commit -m "feat: add article fetching with HTML extraction and word limit"
```

---

### Task 5: Pages Function — Data Point Matching

**Files:**
- Modify: `functions/api/enrich.ts`

- [ ] **Step 1: Add data point loading and matching**

Insert after the `extractTextFromHTML` function:

```typescript
interface DataPoint {
  fact: string;
  source: string;
  sourceFile: string;
  category: string;
  context: string;
}

let cachedDataPoints: DataPoint[] | null = null;

async function loadDataPoints(): Promise<DataPoint[]> {
  if (cachedDataPoints) return cachedDataPoints;

  // Static import — bundler resolves this at build time, cached in isolate
  try {
    const data = (await import("../../reports/data-points.json")).default;
    cachedDataPoints = data as DataPoint[];
  } catch {
    // Fallback: empty array if file doesn't exist
    cachedDataPoints = [];
  }
  return cachedDataPoints;
}

function findRelevantDataPoints(
  articleText: string,
  allPoints: DataPoint[],
  maxResults = 15,
): DataPoint[] {
  const articleLower = articleText.toLowerCase();
  const scored = allPoints.map((point) => {
    const factLower = point.fact.toLowerCase();
    const contextLower = point.context.toLowerCase();

    // Simple keyword overlap score
    const factWords = new Set(factLower.split(/\s+/));
    const articleWords = new Set(articleLower.split(/\s+/));
    const overlap = [...factWords].filter((w) => articleWords.has(w)).length;

    // Boost score if context keywords appear in article
    const contextWords = contextLower.split(/\s+/);
    const contextOverlap = contextWords.filter((w) => articleWords.has(w)).length;

    return {
      point,
      score: overlap + contextOverlap * 0.5,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score > 1) // Minimum relevance threshold
    .slice(0, maxResults)
    .map((s) => s.point);
}
```

- [ ] **Step 2: Integrate matching into handler**

After the word count check, add:

```typescript
  // 6. Match relevant data points
  const allPoints = await loadDataPoints();
  const matchedPoints = findRelevantDataPoints(articleText, allPoints);
```

- [ ] **Step 3: Commit**

```bash
git add functions/api/enrich.ts
git commit -m "feat: add data point matching via keyword overlap scoring"
```

---

### Task 6: Pages Function — LLM Enrichment and Response

**Files:**
- Modify: `functions/api/enrich.ts`

- [ ] **Step 1: Add LLM enrichment function**

Insert after `findRelevantDataPoints`:

```typescript
const SYSTEM_PROMPT = `You are a content enrichment assistant. Your task is to enhance an article by injecting relevant data points where they fit naturally.

Rules:
1. Only use data points from the provided list. Never fabricate data.
2. Insert each data point where it naturally supports or enhances the existing content. Do not force injections where they don't fit.
3. Wrap each injection with [IG]...[/IG] markers.
4. Do not remove or modify any original text outside of the injection areas.
5. Match the article's tone and style. Data points should flow seamlessly.
6. If a data point doesn't fit anywhere in the article, skip it — it's better to have fewer, better injections than forced ones.
7. Return the FULL enriched article text, not just excerpts.`;

async function enrichWithLLM(
  articleText: string,
  dataPoints: DataPoint[],
  apiKey: string,
): Promise<string> {
  const dataPointsFormatted = dataPoints
    .map(
      (dp) =>
        `- FACT: ${dp.fact}\n  SOURCE: ${dp.source}\n  SOURCE FILE: ${dp.sourceFile}\n  CATEGORY: ${dp.category}\n  CONTEXT: ${dp.context}`,
    )
    .join("\n\n");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Article:\n\n${articleText}\n\nAvailable data points:\n\n${dataPointsFormatted}`,
        },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as {
    choices: [{ message: { content: string } }];
  };

  return data.choices[0].message.content;
}

interface Injection {
  fact: string;
  source: string;
  sourceFile: string;
  position: number;
}

function parseInjections(enriched: string, dataPoints: DataPoint[]): Injection[] {
  const injections: Injection[] = [];
  const regex = /\[IG\]([\s\S]*?)\[\/IG\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(enriched)) !== null) {
    const injectedText = match[1].trim();

    // Find the matching data point
    const matched = dataPoints.find((dp) =>
      injectedText.includes(dp.fact.substring(0, 30)),
    );

    if (matched) {
      injections.push({
        fact: matched.fact,
        source: matched.source,
        sourceFile: matched.sourceFile,
        position: match.index,
      });
    }
  }

  return injections;
}
```

- [ ] **Step 2: Integrate enrichment into handler and complete the response**

Replace the placeholder return statement after data point matching with:

```typescript
  // 7. Enrich via LLM
  let enrichedText: string;
  try {
    enrichedText = await enrichWithLLM(articleText, matchedPoints, context.env.DEEPSEEK_API_KEY);
  } catch (err) {
    return buildError(502, { error: "ENRICH_FAILED" });
  }

  // 8. Parse injections from enriched text
  const injections = parseInjections(enrichedText, matchedPoints);

  // 9. Return response
  const responseBody: EnrichResponse = {
    original: articleText,
    enriched: enrichedText,
    injections,
  };

  return new Response(JSON.stringify(responseBody), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
```

- [ ] **Step 3: Commit**

```bash
git add functions/api/enrich.ts
git commit -m "feat: add LLM enrichment with DeepSeek V4 Flash and injection parsing"
```

---

### Task 7: Astro Tool Page

**Files:**
- Create: `src/pages/tools/information-gain.astro`
- Create: `src/lib/information-gain/client.js`

- [ ] **Step 1: Write the Astro page**

Write `src/pages/tools/information-gain.astro`:

```astro
---
import BaseLayout from "../../layouts/BaseLayout.astro";
---

<BaseLayout pageTitle="Information Gain Tool">
```

Note: Update the layout import to match your existing site's layout convention (e.g. `ToolLayout` on seoplus.dev). The layout provides the site chrome (header, footer, nav, theme toggle). If building standalone, replace with a minimal wrapper that includes Tailwind and the dark mode toggle.

```astro
<!-- If no existing layout, use a minimal standalone wrapper: -->
---
---
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Information Gain Tool</title>
</head>
<body class="bg-cream-200 text-warm-800 dark:bg-warm-950 dark:text-cream-200 font-body antialiased">
<div class="px-5 sm:mx-auto sm:max-w-2xl sm:px-8 lg:px-0 md:max-w-6xl grid gap-12 mt-4">
<div class="mx-auto max-w-4xl px-4 sm:px-6 py-12">
```

Then the actual page content (form + results). Close with:

```astro
</div></div></body></html>
```
  <form id="enrich-form" class="bg-cream-100 dark:bg-warm-850 border border-cream-400 dark:border-warm-800 rounded-lg p-6 sm:p-10 shadow-sm">
    <!-- Article URL -->
    <div class="mb-6">
      <label for="article-url" class="block text-sm font-medium text-warm-800 dark:text-cream-200 mb-2">
        Article URL
      </label>
      <input
        type="url"
        id="article-url"
        required
        class="w-full px-4 py-3 border border-cream-400 dark:border-warm-700 rounded-md text-sm bg-cream-100 text-warm-900 dark:bg-cream-100 dark:text-warm-900 focus:outline-none focus:ring-2 focus:ring-amber dark:focus:ring-amber-bright focus:border-transparent"
        placeholder="https://yoursite.com/blog/your-article"
      />
      <p class="text-xs text-warm-700/60 dark:text-cream-400/60 mt-1">
        The article you want to enrich with data points from our research library.
      </p>
    </div>

    <!-- Turnstile -->
    <div class="mb-8">
      <label class="block text-sm font-medium text-warm-800 dark:text-cream-200 mb-2">
        Human verification
      </label>
      <div class="cf-turnstile" data-sitekey={import.meta.env.PUBLIC_TURNSTILE_SITE_KEY}></div>
    </div>

    <!-- Submit -->
    <button
      id="run-btn"
      type="button"
      class="w-full py-3 px-6 bg-amber dark:bg-amber-bright text-cream-50 dark:text-warm-900 rounded-md font-semibold text-base hover:bg-amber/90 dark:hover:bg-amber-bright/90 active:scale-[0.99] transition-all focus:outline-none focus:ring-2 focus:ring-amber dark:focus:ring-amber-bright focus:ring-offset-2 dark:focus:ring-offset-warm-900 min-h-[48px]"
    >
      Run Enrichment &rarr;
    </button>

    <div class="mt-4 p-3 bg-cream-200 dark:bg-warm-800 rounded-md">
      <p class="text-xs text-warm-700/60 dark:text-cream-400/60 font-mono leading-relaxed">
        Rate limit: 10/hr &middot; Max 5,000 words &middot; 10K token budget &middot; Uses DeepSeek V4 Flash
      </p>
    </div>

    <!-- Progress -->
    <div id="progress-area" class="hidden mt-6 p-4 bg-cream-200 dark:bg-warm-800 rounded-lg">
      <div id="progress-list" class="flex flex-col gap-2 text-sm font-mono"></div>
    </div>
  </form>

  <!-- Results Area -->
  <div id="results-area" class="hidden mt-8"></div>
</Layout>

<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
<script src="/scripts/information-gain.js"></script>
</BaseLayout>
```

- [ ] **Step 2: Write the client-side JavaScript**

Write `public/scripts/information-gain.js`:

```javascript
(function () {
  const form = document.getElementById("enrich-form");
  const runBtn = document.getElementById("run-btn");
  const urlInput = document.getElementById("article-url");
  const progressArea = document.getElementById("progress-area");
  const progressList = document.getElementById("progress-list");
  const resultsArea = document.getElementById("results-area");

  function addProgress(msg) {
    progressArea.classList.remove("hidden");
    const el = document.createElement("div");
    el.textContent = msg;
    progressList.appendChild(el);
  }

  function clearProgress() {
    progressList.innerHTML = "";
    progressArea.classList.add("hidden");
  }

  function showError(msg) {
    resultsArea.classList.remove("hidden");
    resultsArea.innerHTML = `
      <div class="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg p-6 text-center">
        <p class="text-red-700 dark:text-red-300 font-medium">${escapeHtml(msg)}</p>
        <button onclick="this.parentElement.parentElement.classList.add('hidden')" class="mt-4 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>
      </div>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderResults(data) {
    resultsArea.classList.remove("hidden");

    // Strip [IG]...[/IG] markers for display, wrap injected facts in highlights
    const enrichedHtml = data.enriched
      .replace(/\[IG\]([\s\S]*?)\[\/IG\]/g, (match, content) => {
        const dp = data.injections.find((inj) =>
          content.trim().includes(inj.fact.substring(0, 30))
        );
        const sourceLink = dp
          ? `<a href="${escapeHtml(dp.sourceFile)}" target="_blank" class="text-xs text-amber dark:text-amber-bright underline hover:no-underline block mt-1">Source: ${escapeHtml(dp.source)}</a>`
          : "";
        return `<mark class="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">${escapeHtml(content.trim())}</mark>${sourceLink}`;
      })
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    resultsArea.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-0 bg-cream-100 dark:bg-warm-850 border border-cream-400 dark:border-warm-800 rounded-lg overflow-hidden shadow-sm">
        <div class="border-b md:border-b-0 md:border-r border-cream-400 dark:border-warm-800 p-6">
          <div class="text-xs font-semibold text-warm-500 dark:text-cream-500 uppercase tracking-wider mb-4">Original</div>
          <div class="text-sm text-warm-800 dark:text-cream-200 leading-relaxed space-y-3">
            <p>${escapeHtml(data.original).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>
          </div>
        </div>
        <div class="p-6">
          <div class="text-xs font-semibold text-warm-500 dark:text-cream-500 uppercase tracking-wider mb-4">Enriched</div>
          <div class="text-sm text-warm-800 dark:text-cream-200 leading-relaxed space-y-3">
            <p>${enrichedHtml}</p>
          </div>
        </div>
      </div>
    `;
  }

  runBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();

    if (!url) {
      showError("Please enter an article URL.");
      return;
    }

    try {
      new URL(url);
    } catch {
      showError("Please enter a valid URL (e.g. https://example.com/article).");
      return;
    }

    const turnstileResponse = document.querySelector(
      '[name="cf-turnstile-response"]'
    )?.value;

    if (!turnstileResponse) {
      showError("Please complete the verification challenge.");
      return;
    }

    clearProgress();
    resultsArea.classList.add("hidden");
    runBtn.disabled = true;
    runBtn.textContent = "Processing...";

    addProgress("Validating request...");

    try {
      const response = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          turnstileToken: turnstileResponse,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errors = {
          INVALID_URL: "Could not validate that URL. Check that it's correct.",
          WORD_LIMIT: `Article exceeds the 5,000 word limit (${data.wordCount} words). Try a shorter article.`,
          RATE_LIMIT: `Rate limit reached. Try again in ${data.retryAfter || "an hour"}.`,
          TURNSTILE_FAILED: "Verification failed. Please refresh and try again.",
          TURNSTILE_MISSING: "Please complete the verification challenge.",
          FETCH_FAILED: "Could not fetch the article. The site may be blocking requests.",
          ENRICH_FAILED: "The enrichment service encountered an error. Please try again.",
        };
        showError(errors[data.error] || "An unexpected error occurred.");
        return;
      }

      addProgress("Enrichment complete. Rendering results...");
      renderResults(data);
    } catch (err) {
      showError("Network error. Please check your connection and try again.");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run Enrichment \u2192";
      clearProgress();
    }
  });
})();
```

- [ ] **Step 3: Add Turnstile public key to environment config**

Add to `.env` (or Cloudflare Pages environment variables):

```
PUBLIC_TURNSTILE_SITE_KEY=your-turnstile-site-key
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/tools/information-gain.astro public/scripts/information-gain.js
git commit -m "feat: add Astro tool page with Turnstile and side-by-side results rendering"
```

---

### Task 8: Integration — Wire Reports Directory for Serving

**Files:**
- Modify: `astro.config.mjs` (if exists) or `public/reports/` setup

- [ ] **Step 1: Ensure reports are publicly accessible**

Since reports need to be reachable at `/reports/*.md`, either:
- Copy reports into `public/reports/` (for Astro static serving)
- Or configure Astro to include reports

For Astro, the simplest approach is to symlink or copy:

```bash
mkdir -p public
ln -s ../reports public/reports
```

Or if Astro is also in this repo, `public/reports/` is served directly.

- [ ] **Step 2: Add `.superpowers/` to `.gitignore`**

```bash
echo ".superpowers/" >> .gitignore
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore public/reports/
git commit -m "feat: wire reports directory for public serving"
```

---

### Task 9: Cloudflare Pages Configuration

**Files:**
- Create: `wrangler.toml` (or configure via Cloudflare Dashboard)

- [ ] **Step 1: Configure Cloudflare Pages secrets**

Set the following secrets via `wrangler` or Cloudflare Dashboard:

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put TURNSTILE_SECRET_KEY
```

- [ ] **Step 2: Add environment variables for Turnstile site key**

In Cloudflare Pages Dashboard > Settings > Environment variables:

```
PUBLIC_TURNSTILE_SITE_KEY = your-turnstile-site-key
```

- [ ] **Step 3: Deploy and test**

```bash
wrangler pages deploy
```

---

