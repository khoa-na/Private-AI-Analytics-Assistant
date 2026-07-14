import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { datasetSlug } from "../lib/datasetImport";
import { reviewDataset } from "../lib/datasetReview";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const requested = process.argv[2];
if (!requested) {
  console.error("Usage: npm run dataset:review -- <staged-dataset-name> [--no-ai]");
  process.exit(1);
}

try {
  const name = datasetSlug(requested);
  const report = await reviewDataset(join(resolve("data"), "staging", name), name, {
    useAi: !process.argv.includes("--no-ai"),
  });
  console.log(`Reviewed dataset: ${name}`);
  console.log(`Decision: ${report.decision}`);
  console.log(`Relationships: ${report.relationships.filter(({ decision }) => decision === "approved").length} approved`);
  console.log(`Measures: ${report.measures.filter(({ decision }) => decision === "approved").length} approved`);
  for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
