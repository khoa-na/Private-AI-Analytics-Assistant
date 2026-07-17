import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateStagedBundle, writeDatasetBundle } from "../lib/datasetBundle";
import { createDatasetDraft } from "../lib/datasetDraft";
import { refreshDataset, stageDataset } from "../lib/datasetImport";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const source = process.argv[2];
const name = process.argv.find((argument) => argument.startsWith("--name="))?.slice(7);
const noAi = process.argv.includes("--no-ai");
const refresh = process.argv.includes("--refresh");
if (!source) {
  console.error("Usage: npm run dataset:import -- <duckdb-file|CSV/TSV/Parquet-directory> [--name=dataset-name] [--no-ai] [--refresh]");
  process.exit(1);
}

try {
  const { directory, profile } = refresh
    ? await refreshDataset(source, undefined, name)
    : await stageDataset(source, undefined, name);
  if (noAi) {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  }
  let previousSemantic: unknown;
  const active = resolve("data", "active");
  if (existsSync(join(active, "semantic.json"))) {
    try {
      const { manifest } = await validateStagedBundle(active, profile.dataset);
      if (manifest.state === "active") previousSemantic = JSON.parse(readFileSync(join(active, "semantic.json"), "utf8"));
    } catch (error) {
      console.warn(`Existing active semantics were not reused: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const draft = await createDatasetDraft(profile, previousSemantic);
  await writeDatasetBundle(directory, {
    "dataset-profile.json": `${JSON.stringify(profile, null, 2)}\n`,
    "dataset-catalog.json": draft.catalogJson,
    "dataset.md": draft.markdown,
    "dataset.runtime.md": draft.runtimeMarkdown,
    "semantic.json": draft.semanticJson,
  }, {
    dataset: profile.dataset,
    sourcePath: source,
    generatedBy: draft.generatedBy,
    ...(draft.generatedBy === "ai" && process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
  });
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
