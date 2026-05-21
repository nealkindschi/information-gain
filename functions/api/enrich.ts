import reportTitles from "./report-titles";

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
    category: string;
    reportTitle: string;
    position: number;
  }>;
}

interface ErrorResponse {
  error: string;
  detail?: string;
  wordCount?: number;
  retryAfter?: number | string;
}

type RateLimitStore = Map<string, { count: number; resetAt: number }>;

const rateLimitStore: RateLimitStore = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_WORDS = 20000;
const MAX_TOKENS = 30000;
const FETCH_TIMEOUT_MS = 3000;

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
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function fetchArticle(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Detect bot-protection/challenge pages
    if (
      html.includes("cf-browser-verify") ||
      html.includes("cf_challenge") ||
      html.includes("_cf_chl_opt") ||
      html.includes("challenge-platform") ||
      html.includes("cf-wrapper") ||
      html.includes("window._cf_chl") ||
      (html.includes('class="no-js') && html.includes("<!--[if")) ||
      (html.includes("Cloudflare") && html.includes("checking your browser")) ||
      (html.includes("Just a moment") && html.includes("security"))
    ) {
      throw new Error("CF_CHALLENGE");
    }

    const text = extractTextFromHTML(html);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

function extractTextFromHTML(html: string): string {
  let text = html
    // Remove entire non-content elements with their contents
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template[^>]*>[\s\S]*?<\/template>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    // Convert block elements to paragraph breaks
    .replace(/<\/(p|div|h[1-6]|li|section|article|header|footer|main|aside|blockquote|pre|table|tr|figure|figcaption|details|summary)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(ul|ol|dl)>/gi, "\n")
    // Self-closing block elements
    .replace(/<\/?(hr|img)[^>]*\/?>/gi, "\n")
    // Strip remaining inline tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&nbsp;/g, " ")
    // Normalize whitespace within paragraphs (but preserve paragraph breaks)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();

  return text;
}

interface DataPoint {
  fact: string;
  sourceFile: string;
  category: string;
  context: string;
}

let cachedDataPoints: DataPoint[] | null = null;

async function loadDataPoints(baseUrl: string): Promise<DataPoint[]> {
  if (cachedDataPoints) return cachedDataPoints;
  const response = await fetch(`${baseUrl}/data-points.json`);
  if (!response.ok) {
    throw new Error(`Failed to load data points: ${response.status}`);
  }
  cachedDataPoints = await response.json() as DataPoint[];
  return cachedDataPoints;
}

function findRelevantDataPoints(
  articleText: string,
  allPoints: DataPoint[],
  maxResults = 5,
): DataPoint[] {
  if (allPoints.length === 0) return [];

  const articleLower = articleText.toLowerCase();
  const scored = allPoints.map((point) => {
    const factLower = point.fact.toLowerCase();
    const contextLower = point.context.toLowerCase();

    const factWords = new Set(factLower.split(/\s+/));
    const articleWords = new Set(articleLower.split(/\s+/));
    const overlap = [...factWords].filter((w) => articleWords.has(w)).length;

    const contextWords = contextLower.split(/\s+/);
    const contextOverlap = contextWords.filter((w) => articleWords.has(w)).length;

    return { point, score: overlap + contextOverlap * 0.5 };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score > 1)
    .slice(0, maxResults)
    .map((s) => s.point);
}

interface Injection {
  fact: string;
  source: string;
  sourceFile: string;
  category: string;
  reportTitle: string;
  position: number;
}

const SYSTEM_PROMPT = `You are a content enrichment assistant. Your task is to enhance an article by injecting relevant data points where they fit naturally.

Step 1 — Analyze voice and tone:
Read the article carefully. Identify its voice, tone, and writing style. Note sentence structure, vocabulary level, and cadence. Is it formal or conversational? Technical or accessible? Journalistic or marketing?

Step 2 — Inject data points:
Using the voice you identified in Step 1, insert specific, quantitative data points from the provided list where they naturally support the content. Each injection must be a precise statement of fact, not a generalization or meta-commentary about the source. Follow these requirements for every injection:

- State the exact, specific data point (numbers, percentages, named events, concrete findings from the list). Never inject a vague observation or hand-wavy claim.
- Name the authoritative source explicitly with year (e.g., "the NIST AI Risk Management Framework," "Stanford's 2025 AI Index," "Anthropic's August 2025 Threat Intelligence Report"). Never use weasel words like "research shows," "studies indicate," or "according to a report."
- Inject the DATA itself, not the report. Say "78% of organizations now use AI, according to the Stanford AI Index 2025" — not "The Stanford AI Index published findings about enterprise AI adoption."
- First try to weave the data point into an existing sentence near where it fits. Only add a standalone sentence if inline integration is impossible. Each injection must be exactly one sentence, no more than 30 words. Never produce a run-on catalogue listing multiple items (including X, Y, Z...) — pick the single most impactful point.

After each injection, re-read the surrounding text to verify: the copy flows logically, the tone and vocabulary match the original, and the statement reads as an authoritative, sourced fact rather than a casual observation or filler text.

Rules:
1. Only use data points from the provided list. Never fabricate data. Reject data points that are vague, generic, or common knowledge — only inject facts that a reader could not obtain by asking a general-purpose AI chatbot.
2. Each injection must be exactly one sentence and no more than 30 words. It must include both the specific fact AND the named source with year (e.g., "According to Stanford's 2025 AI Index, 78% of organizations now use AI"). Never use "research shows," "studies indicate," "a report found," or any unattributed attribution. If the injection does not name an authoritative source, do not write it. Never produce a run-on sentence that lists multiple items, effects, or categories — pick the single most impactful point. Injections that read like catalogues (including X, Y, Z, A, B, C...) are prohibited.
3. Wrap each injection with markers in this exact format: [IG src="SOURCE_FILE"]injected text[/IG]. Replace SOURCE_FILE with the path from the data point (e.g. [IG src="/reports/nist-ai-100.pdf"]Only 12% of orgs lack formal AI security policies[/IG]). Do NOT use square brackets [ ] anywhere inside the injected text — this breaks parsing.
4. Do not remove or modify any original text outside of the injection areas.
5. Match the article's tone, voice, sentence length, and vocabulary level exactly. After each insertion, re-read the surrounding text to confirm the copy remains logical, the transition is natural, and the style is indistinguishable from the original.
6. If a data point is widely known, generic, or common knowledge (e.g. "AI is growing rapidly"), skip it. Only inject novel, specific, research-backed facts that pass the "novelty test": if any general-purpose AI could generate this statement from its training data, do not inject it.
7. Preserve the original article's paragraph structure exactly. Maintain all paragraph separations (double newlines between paragraphs) as they appear in the input. Return the FULL enriched article text, including all unchanged portions.
12. Never meta-report: do not write about what a report "addresses," "covers," "found," or "published." Only write the data point itself, attributed to the source. The source exists to give the fact authority, not as the subject of the sentence.

Anti-slop rules:
8. Never use em dashes (—). Use commas, periods, or semicolons instead.
9. Never use "it's not X — it's Y" or "not just X, but Y" sentence patterns. State facts directly.
10. No fluff. Cut filler words and phrases. Every sentence must carry information.
11. Do not use HTML entities (&#8221;, &#8217;, &mdash;, etc.) in the injected text. Use plain Unicode characters instead.`;

async function enrichWithLLM(
  articleText: string,
  dataPoints: DataPoint[],
  apiKey: string,
): Promise<string> {
  const dataPointsFormatted = dataPoints
    .map(
      (dp) => {
        const title = reportTitles[dp.sourceFile]?.title ?? dp.sourceFile.replace(/^\/reports\//, "").replace(/\.pdf$/, "");
        return `- FACT: ${dp.fact}\n  SOURCE: ${title}\n  CATEGORY: ${dp.category}\n  CONTEXT: ${dp.context}`;
      }
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
      max_tokens: 3072,
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

  const raw = data.choices[0].message.content;

  // Strip any unclosed/dangling IG markers (from truncated responses)
  const cleaned = raw
    .replace(/\[IG\s+src="[^"]*"\]/g, "")  // unclosed opening tags
    .replace(/\[\/IG\]/g, "");               // orphan closing tags

  return cleaned;
}

function parseInjections(enriched: string, dataPoints: DataPoint[]): Injection[] {
  const injections: Injection[] = [];
  const regex = /\[IG\s+src="([^"]*)"\]([\s\S]*?)\[\/IG\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(enriched)) !== null) {
    const sourceFile = match[1];
    const injectedText = match[2].trim();

    // Best-effort: match back to data point for fact/source details
    const matched = dataPoints.find((dp) =>
      injectedText.includes(dp.fact.substring(0, 30)),
    );

    injections.push({
      fact: matched?.fact ?? injectedText.substring(0, 120),
      source: sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, ""),
      sourceFile: sourceFile,
      reportTitle: reportTitles[sourceFile]?.title ?? sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, ""),
      category: matched?.category ?? "data",
      position: match.index,
    });
  }

  return injections;
}

type Env = {
  DEEPSEEK_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (context.request.method !== "POST") {
    return buildError(405, { error: "METHOD_NOT_ALLOWED" });
  }

  let body: EnrichRequest;
  try {
    body = await context.request.json<EnrichRequest>();
  } catch {
    return buildError(400, { error: "INVALID_JSON" });
  }

  const ip = getIP(context.request);

  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return buildError(429, {
      error: "RATE_LIMIT",
      retryAfter: rateCheck.retryAfter,
    });
  }

  if (!body.url || !isValidURL(body.url)) {
    return buildError(400, { error: "INVALID_URL" });
  }

  if (!body.turnstileToken) {
    return buildError(400, { error: "TURNSTILE_MISSING" });
  }

  const turnstileValid = await verifyTurnstile(body.turnstileToken, ip, context.env.TURNSTILE_SECRET_KEY);
  if (!turnstileValid) {
    return buildError(400, { error: "TURNSTILE_FAILED" });
  }

  // 4. Fetch article
  let articleText: string;
  try {
    articleText = await fetchArticle(body.url);
  } catch (err) {
    if (err instanceof Error && err.message === "CF_CHALLENGE") {
      return buildError(502, { error: "FETCH_CF_BLOCKED", detail: "Target site uses bot protection. Try a different article URL." });
    }
    if (err instanceof Error && err.message.startsWith("HTTP")) {
      return buildError(502, { error: "FETCH_BAD_STATUS", detail: err.message });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return buildError(502, { error: "FETCH_TIMEOUT" });
    }
    return buildError(502, { error: "FETCH_BLOCKED" });
  }

  // 5. Word count check
  const wordCount = countWords(articleText);
  if (wordCount > MAX_WORDS) {
    return buildError(400, {
      error: "WORD_LIMIT",
      wordCount,
    });
  }

  // 6. Match relevant data points
  const url = new URL(context.request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const allPoints = await loadDataPoints(baseUrl);
  const matchedPoints = findRelevantDataPoints(articleText, allPoints);

  // Token budget check
  const estimatedInputTokens = estimateTokens(articleText) +
    matchedPoints.reduce((sum, dp) => sum + estimateTokens(dp.fact + dp.context), 0);
  if (estimatedInputTokens > MAX_TOKENS * 0.6) {
    return buildError(413, { error: "TOKEN_BUDGET" });
  }

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
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
};
