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
  return Math.ceil(countWords(text) * 1.3);
}

function resolveReportTitle(sourceFile: string): string {
  return reportTitles[sourceFile]?.title ?? sourceFile.replace(/^\/reports\//, "").replace(/\.pdf$/, "");
}

function extractTextFromHTML(html: string): string {
  // Single-pass CPU-light extraction: strip tags, keep paragraph breaks
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "\n")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "\n")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "\n")
    .replace(/<\/p>|<\/h[1-6]>|<\/li>|<\/div>|<\/section>|<\/article>|<\/blockquote>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
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
  maxResults = 10,
): DataPoint[] {
  if (allPoints.length === 0) return [];

  const articleWords = new Set(articleText.toLowerCase().split(/\s+/));
  const top: { point: DataPoint; score: number }[] = [];
  let worstScore = 0;

  for (let i = 0; i < allPoints.length; i++) {
    const p = allPoints[i];
    const words = p.fact.toLowerCase().split(/\s+/);
    let score = 0;

    for (let w = 0; w < words.length; w++) {
      if (articleWords.has(words[w])) score++;
    }

    if (score <= 1) continue;

    if (top.length < maxResults) {
      top.push({ point: p, score });
      if (top.length === maxResults) {
        top.sort((a, b) => b.score - a.score);
        worstScore = top[maxResults - 1].score;
      }
    } else if (score > worstScore) {
      for (let t = 0; t < maxResults; t++) {
        if (top[t].score === worstScore) {
          top[t] = { point: p, score };
          break;
        }
      }
      top.sort((a, b) => b.score - a.score);
      worstScore = top[maxResults - 1].score;
    }
  }

  top.sort((a, b) => b.score - a.score);
  return top.map((s) => s.point);
}

interface Injection {
  fact: string;
  source: string;
  sourceFile: string;
  category: string;
  reportTitle: string;
  position: number;
}

const SYSTEM_PROMPT = `Insert data points from the list into the article. Every insertion MUST be wrapped EXACTLY like this — no exceptions:

[IG src="/reports/source-file.pdf"]The injected sentence here[/IG]

Rules:
- Name the source with year (e.g., "According to the NIST AI Risk Management Framework...").
- Never use "research shows" or "studies indicate." Name the specific source.
- One or two short sentences per injection, ≤40 words total. Match the article's tone.
- Connect each injection to the paragraph it sits in — it should read like it belongs there.
- Inject 2-5 data points across the article.
- Return the full article with insertions inline. No introductions or conclusions. Do not echo the article without insertions.`;

async function enrichWithLLM(
  articleText: string,
  dataPoints: DataPoint[],
  apiKey: string,
): Promise<string> {
  // Trim article to control execution time (LLM processing scales with input size)
  const trimmedArticle = articleText.length > 10000
    ? articleText.slice(0, 10000)
    : articleText;

  const dataPointsFormatted = dataPoints
    .map((dp) => {
      const title = resolveReportTitle(dp.sourceFile);
      return `- FACT: ${dp.fact}\n  SOURCE FILE: ${dp.sourceFile}\n  SOURCE: ${title}\n  CATEGORY: ${dp.category}\n  CONTEXT: ${dp.context}`;
    })
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
          content: `Article:\n\n${trimmedArticle}\n\nAvailable data points:\n\n${dataPointsFormatted}`,
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

  const cleaned = data.choices[0].message.content;

  return cleaned;
}

function parseInjections(enriched: string, dataPoints: DataPoint[]): Injection[] {
  const injections: Injection[] = [];
  const regex = /\[IG\s+src="([^"]*)"\]([\s\S]*?)\[\/IG\]/g;
  let match: RegExpExecArray | null;

  // Pre-compute fact prefixes for matching
  const prefixes = dataPoints.map((dp) => dp.fact.substring(0, 30));

  while ((match = regex.exec(enriched)) !== null) {
    const sourceFile = match[1];
    const injectedText = match[2].trim();

    // Best-effort: match back to data point for fact/source details
    let matched: DataPoint | undefined;
    for (let i = 0; i < dataPoints.length; i++) {
      if (injectedText.includes(prefixes[i])) {
        matched = dataPoints[i];
        break;
      }
    }

    injections.push({
      fact: matched?.fact ?? injectedText.substring(0, 120),
      source: sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, ""),
      sourceFile: sourceFile,
      reportTitle: resolveReportTitle(sourceFile),
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

  // Token budget check (skip string concat for estimation)
  const articleTokens = estimateTokens(articleText);
  const dataTokens = matchedPoints.reduce((sum, dp) => sum + estimateTokens(dp.fact) + estimateTokens(dp.context), 0);
  if (articleTokens + dataTokens > MAX_TOKENS * 0.6) {
    return buildError(413, { error: "TOKEN_BUDGET" });
  }

  // 7. Enrich via LLM
  let enrichedText: string;
  try {
    enrichedText = await enrichWithLLM(articleText, matchedPoints, context.env.DEEPSEEK_API_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildError(502, { error: "ENRICH_FAILED", detail: msg });
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
