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
  category: string;
  context: string;
}

const SYSTEM_PROMPT = `You are a data extraction assistant. Given a research report, extract every discrete, citable fact, statistic, case study result, and named insight.

Return a JSON object with a "data_points" key containing an array of data point objects, each with these fields:
- fact: The exact fact or data point as a quoted statement (e.g. "Only 12% of content achieves an IGS above 0.7")
- source: The domain or publication name where this fact originated (e.g. "searchbloom.com")
- sourceFile: The relative path to the source report (e.g. "/reports/nist-ai-100.pdf")
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
    throw new Error(
      `DeepSeek API error: ${response.status} ${await response.text()}`
    );
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
    .filter((f: string) => f.endsWith(".pdf"));

  if (files.length === 0) {
    console.log("No PDF files found in reports/");
    process.exit(0);
  }

  const allDataPoints: DataPoint[] = [];

  for (const file of files) {
    console.log(`Processing: ${file}`);
    const filePath = path.join(REPORTS_DIR, file);

    try {
      const text = await extractTextFromPDF(filePath);
      console.log(`  Extracted ${text.length} characters`);

      let textForExtraction = text;
      if (text.length > 30000) {
        console.log(`  Truncating text from ${text.length} to 30000 characters`);
        textForExtraction = text.slice(0, 30000);
      }
      const points = await extractDataPoints(
        textForExtraction,
        `/reports/${file}`
      );
      console.log(`  Extracted ${points.length} data points`);
      allDataPoints.push(...points);
    } catch (err) {
      console.error(`  Failed to process ${file}: ${err}`);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(allDataPoints, null, 2));
  console.log(
    `\nWrote ${allDataPoints.length} total data points to ${OUTPUT}`
  );
}

main().catch(console.error);
