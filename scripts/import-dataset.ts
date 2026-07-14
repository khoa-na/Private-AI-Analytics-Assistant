import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatasetDraft } from "../lib/datasetDraft";
import { refreshDataset, stageDataset } from "../lib/datasetImport";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const source = process.argv[2];
const name = process.argv.find((argument) => argument.startsWith("--name="))?.slice(7);
const noAi = process.argv.includes("--no-ai");
const refresh = process.argv.includes("--refresh");
if (!source) {
  console.error("Usage: npm run dataset:import -- <sqlite-file|dataset-directory> [--name=dataset-name] [--no-ai] [--refresh]");
  process.exit(1);
}

try {
  const { directory, profile } = refresh
    ? refreshDataset(source, undefined, name)
    : await stageDataset(source, undefined, name);
  if (noAi) {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  }
  const draft = await createDatasetDraft(profile);
  writeFileSync(join(directory, "dataset-profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(join(directory, "dataset-catalog.json"), draft.catalogJson);
  writeFileSync(join(directory, "dataset.md"), draft.markdown);
  writeFileSync(join(directory, "dataset.runtime.md"), draft.runtimeMarkdown);
  writeFileSync(join(directory, "semantic.json"), draft.semanticJson);
  console.log(`Staged dataset: ${profile.dataset}`);
  console.log(`Tables: ${profile.tables.length}`);
  console.log(`Rows: ${profile.tables.reduce((total, table) => total + table.rowCount, 0)}`);
  console.log(`Guide: ${draft.generatedBy}`);
  if (draft.generationError) console.warn(`AI enrichment failed: ${draft.generationError}`);
  console.log(`Review: ${directory}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
