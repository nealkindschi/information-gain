import dataPointsDefault from "./data-points";
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
  wordCount?: number;
  retryAfter?: string;
}

type RateLimitStore = Map<string, { count: number; resetAt: number }>;

const rateLimitStore: RateLimitStore = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
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
          "Mozilla/5.0 (compatible; InformationGainBot/1.0; +https://seoplus.dev/tools/information-gain)",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
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

interface DataPoint {
  fact: string;
  source: string;
  sourceFile: string;
  reportTitle: string;
  category: string;
  context: string;
}

let cachedDataPoints: DataPoint[] | null = null;

function loadDataPoints(): DataPoint[] {
  if (cachedDataPoints) return cachedDataPoints;
  cachedDataPoints = dataPointsDefault as DataPoint[];
  return cachedDataPoints;
}

function findRelevantDataPoints(
  articleText: string,
  allPoints: DataPoint[],
  maxResults = 15,
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
Using the voice you identified in Step 1, insert data points from the provided list where they naturally support the content. Write injections in the same voice as the original article — they should sound like the same author wrote them.

Rules:
1. Only use data points from the provided list. Never fabricate data.
2. Insert each data point where it naturally supports or enhances the existing content.
3. Wrap each injection with markers in this exact format: [IG src="SOURCE_FILE"]injected text[/IG]. Replace SOURCE_FILE with the path from the data point (e.g. [IG src="/reports/nist-ai-100.pdf"]Only 12% of orgs lack formal AI security policies[/IG]). Do NOT use square brackets [ ] anywhere inside the injected text — this breaks parsing.
4. Do not remove or modify any original text outside of the injection areas.
5. Match the article's tone, voice, sentence length, and vocabulary level exactly.
6. If a data point is widely known, generic, or common knowledge (e.g. "AI is growing rapidly"), skip it. Only inject novel, specific, research-backed facts that add real information gain.
7. Return the FULL enriched article text, including all unchanged portions.

Anti-slop rules:
8. Never use em dashes (—). Use commas, periods, or semicolons instead.
9. Never use "it's not X — it's Y" or "not just X, but Y" sentence patterns. State facts directly.
10. No fluff. Cut filler words and phrases. Every sentence must carry information.`;

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
      source: matched?.source ?? sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, ""),
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
  const allPoints = loadDataPoints();
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
