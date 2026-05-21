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
  category: string;
  context: string;
}

let cachedDataPoints: DataPoint[] | null = null;

async function loadDataPoints(): Promise<DataPoint[]> {
  if (cachedDataPoints) return cachedDataPoints;

  try {
    const data = await import("../../reports/data-points.json");
    cachedDataPoints = data.default as DataPoint[];
  } catch {
    cachedDataPoints = [];
  }
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

  // 6. Match relevant data points
  const allPoints = await loadDataPoints();
  const matchedPoints = findRelevantDataPoints(articleText, allPoints);

  // 7. Enrich via LLM (Task 6)

  return new Response(JSON.stringify({ status: "matched", wordCount, matches: matchedPoints.length }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
