# Product Requirements Document — Information Gain Tool

## Core Value Proposition

A content enrichment tool that refreshes existing articles by injecting data points, statistics, and evidence extracted exclusively from a curated library of provided source reports — never from the web.

## Primary User

SEO practitioners enriching articles with novel data to improve information gain scores. Also built as a public portfolio tool on seoplus.dev/tools/ to demonstrate AI-assisted content workflows.

## MVP Feature

1. User pastes the **URL of an article**
2. Tool fetches the article's content
3. Tool scans the article for opportunities to inject data points, statistics, or facts
4. Tool searches a pre-loaded **reports repository** (curated set of source documents stored as Markdown files) for relevant supporting evidence
5. Output displays **original text alongside enriched text**, with **source attribution** — every injected data point links back to the specific Markdown file it came from
6. The reports repository is populated by converting source documents (PDFs, web articles, etc.) into Markdown files automatically before use

## Explicit Exclusions (MVP)

| Exclusion | Rationale |
|---|---|
| No live web search | Data comes exclusively from pre-loaded reports |
| No user-uploaded reports | Reports are a fixed curated library managed by the tool author |
| No batch processing | One article at a time |
| No CMS integration | Standalone tool page only, no WordPress/Webflow plugins |
| No scheduled enrichment | Manual trigger only |

## Future Milestones (V2+)

- Integration into build pipelines (CI/CD, content workflows)
- User-uploaded reports
- Batch enrichment
- opencode skill variant for agent-driven enrichment
