import fs from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";

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
  reportTitle: string;
  category: string;
  context: string;
}

const SYSTEM_PROMPT = `You are a data extraction assistant. Given a research report, extract every discrete, citable fact, statistic, case study result, and named insight.

First, identify the report's full title from the document text.

Return a JSON object with:
- "report_title": The full title of the report/document
- "data_points": An array of data point objects, each with these fields:
  - fact: The exact fact or data point as a quoted statement (e.g. "Only 12% of content achieves an IGS above 0.7")
  - source: The domain or publication name where this fact originated (e.g. "searchbloom.com")
  - sourceFile: The relative path to the source report (e.g. "/reports/nist-ai-100.pdf")
  - reportTitle: The full title of the report (e.g. "NIST AI Risk Management Framework")
  - category: One of "statistic", "case_study", "definition", "framework", "expert_quote", "benchmark"
  - context: A short phrase describing what topic/section this fact relates to

Only include specific, citable facts. Do NOT extract narrative prose, opinion without data, or vague generalities. Each fact must be verifiable and attributable.`;

async function extractTextFromPDF(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const pdf = new PDFParse({ data: buffer });
  const result = await pdf.getText();
  await pdf.destroy();
  return result.text;
}

async function extractDataPoints(
  text: string,
  filename: string
): Promise<DataPoint[]> {
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
        { role: "user", content: `Source file: ${filename}\n\n${text}` },
      ],
      max_tokens: 8000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `DeepSeek API error: ${response.status} ${body.slice(0, 200)}`
    );
  }

  const data = (await response.json()) as {
    choices: [{ message: { content: string } }];
  };
  const rawContent = data.choices[0].message.content;
  let parsed: { report_title?: string; data_points?: Omit<DataPoint, "reportTitle">[] };

  try {
    parsed = JSON.parse(rawContent);
  } catch {
    // Try to repair truncated JSON by closing array/object
    const repaired = rawContent.replace(/(,\s*)?$/, "").trim();
    if (!repaired.endsWith("]")) {
      // Find last complete fact and close the array
      const lastComma = repaired.lastIndexOf('",');
      if (lastComma > 0) {
        parsed = JSON.parse(repaired.slice(0, lastComma + 1) + "\n  ]\n}");
      } else {
        throw new Error(`Unrepairable JSON response`);
      }
    } else {
      throw new Error(`JSON parse failed for response`);
    }
  }

  const reportTitle = (parsed.report_title as string) || filename.replace(/^\/reports\//, "").replace(/\.pdf$/, "");
  const points = (parsed.data_points || []) as Omit<DataPoint, "reportTitle">[];
  return points.map((p) => ({ ...p, reportTitle }));
}

async function main() {
  const specifiedFiles = process.argv.slice(2);
  const allFiles = fs
    .readdirSync(REPORTS_DIR)
    .filter((f: string) => f.endsWith(".pdf"));
  const files = specifiedFiles.length > 0
    ? allFiles.filter((f) => specifiedFiles.includes(f))
    : allFiles;

  if (files.length === 0) {
    console.log("No matching PDF files found in reports/");
    process.exit(0);
  }

  const allDataPoints: DataPoint[] = [];
  const existingFiles = new Set<string>();

  if (fs.existsSync(OUTPUT)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT, "utf-8")) as DataPoint[];
    for (const dp of existing) {
      existingFiles.add(dp.sourceFile);
      allDataPoints.push(dp);
    }
    console.log(`Loaded ${existing.length} existing data points from ${OUTPUT}`);
  }

  for (const file of files) {
    const sourcePath = `/reports/${file}`;
    if (existingFiles.has(sourcePath)) {
      console.log(`Skipping: ${file} (already extracted)`);
      continue;
    }
    console.log(`Processing: ${file}`);
    const filePath = path.join(REPORTS_DIR, file);

    try {
      const text = await extractTextFromPDF(filePath);
      console.log(`  Extracted ${text.length} characters`);

      const CHUNK_SIZE = 25000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }

      console.log(`  Split into ${chunks.length} chunk(s)`);

      // Process chunks concurrently with resilience
      const CONCURRENCY = 3;
      for (let ci = 0; ci < chunks.length; ci += CONCURRENCY) {
        const batch = chunks.slice(ci, ci + CONCURRENCY);
        const batchStart = ci + 1;
        console.log(`  Chunks ${batchStart}-${batchStart + batch.length - 1}/${chunks.length}`);
        const results = await Promise.allSettled(
          batch.map((chunk) =>
            extractDataPoints(chunk, `/reports/${file}`)
          )
        );
        let batchOk = 0;
        for (let ri = 0; ri < results.length; ri++) {
          const result = results[ri];
          if (result.status === "fulfilled") {
            allDataPoints.push(...result.value);
            batchOk++;
          } else {
            console.log(`    Chunk ${batchStart + ri} failed: ${result.reason}`);
          }
        }
        if (batchOk < batch.length) {
          console.log(`    ${batchOk}/${batch.length} chunks succeeded`);
        }
      }

      console.log(`  Total points so far: ${allDataPoints.length}`);
    } catch (err) {
      console.error(`  Failed to process ${file}: ${err}`);
    }
  }

  // Final deduplication across all reports
  const before = allDataPoints.length;
  const seen = new Set<string>();
  const deduped: DataPoint[] = [];
  for (const dp of allDataPoints) {
    const key = dp.fact.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(dp);
    }
  }
  console.log(`\nRemoved ${before - deduped.length} total duplicates`);
  allDataPoints.length = 0;
  allDataPoints.push(...deduped);

  fs.writeFileSync(OUTPUT, JSON.stringify(allDataPoints, null, 2));
  console.log(
    `\nWrote ${allDataPoints.length} total data points to ${OUTPUT}`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
