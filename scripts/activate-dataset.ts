import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { validateApprovedSemantic } from "../lib/datasetDraft";
import { datasetSlug, profileDatabase } from "../lib/datasetImport";

export function activateDataset(requested: string, data = resolve("data")) {
  const name = datasetSlug(requested);
  const source = join(data, "staging", name);
  const database = join(source, "database.sqlite");
  const markdown = join(source, "dataset.md");
  const runtimeMarkdown = join(source, "dataset.runtime.md");
  const catalog = join(source, "dataset-catalog.json");
  const semanticPath = join(source, "semantic.json");
  const next = join(data, "active.next");
  const active = join(data, "active");
  const previous = join(data, "active.previous");

  for (const path of [database, markdown, runtimeMarkdown, catalog, semanticPath]) {
    if (!existsSync(path)) throw new Error(`Missing staged artifact: ${path}`);
  }
  const profile = profileDatabase(database, name);
  validateApprovedSemantic(JSON.parse(readFileSync(semanticPath, "utf8")), profile);
  if (Buffer.byteLength(`${readFileSync(runtimeMarkdown, "utf8")}\n${readFileSync(semanticPath, "utf8")}`) > 12_000) {
    throw new Error("Dataset guide is larger than the 12 KB runtime limit.");
  }
  if (existsSync(next)) throw new Error(`Temporary activation path already exists: ${next}`);

  renameSync(source, next);
  try {
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(active)) renameSync(active, previous);
    renameSync(next, active);
  } catch (error) {
    if (existsSync(previous) && !existsSync(active)) renameSync(previous, active);
    if (existsSync(next) && !existsSync(source)) renameSync(next, source);
    throw error;
  }
  try {
    rmSync(previous, { recursive: true, force: true });
  } catch {
    console.warn(`Warning: old inactive dataset could not be removed: ${previous}`);
  }

  console.log(`Activated dataset: ${name}`);
  console.log(`Database: ${join(active, "database.sqlite")}`);
  if (existsSync(".env.local")) {
    const environment = readFileSync(".env.local", "utf8");
    const overrides = [
      environment.match(/^ACTIVE_DATABASE_PATH=(.*)$/m)?.[1],
      environment.match(/^ACTIVE_DATASET_GUIDE_PATHS=(.*)$/m)?.[1],
    ].filter((value): value is string => Boolean(value));
    if (overrides.some((value) => !/data[\\/]active[\\/]/i.test(value))) {
      console.warn("Warning: .env.local overrides the activated bundle; update or remove its ACTIVE_* dataset paths.");
    }
  }
}

if (import.meta.main) {
  const requested = process.argv[2];
  if (!requested) {
    console.error("Usage: npm run dataset:activate -- <staged-dataset-name>");
    process.exit(1);
  }
  try {
    activateDataset(requested);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
