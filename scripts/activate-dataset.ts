import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DATABASE_NAME, quickCheckDatabase, transitionBundleState, validateStagedBundle } from "../lib/datasetBundle";
import { validateApprovedSemantic } from "../lib/datasetDraft";
import { datasetSlug } from "../lib/datasetImport";

export function recoverActivation(source: string, next: string, active: string, previous: string) {
  const completed = existsSync(active) && !existsSync(next) && !existsSync(source);
  if (completed) return true;
  if (!existsSync(active) && existsSync(previous)) renameSync(previous, active);
  if (existsSync(next)) {
    if (existsSync(source)) {
      throw new Error(`Both staged and temporary activation bundles exist; inspect ${source} and ${next}.`);
    }
    renameSync(next, source);
  }
  if (existsSync(active) && existsSync(previous)) rmSync(previous, { recursive: true, force: true });
  return false;
}

export async function activateDataset(requested: string, data = resolve("data")) {
  const name = datasetSlug(requested);
  const source = join(data, "staging", name);
  const database = join(source, DATABASE_NAME);
  const runtimeMarkdown = join(source, "dataset.runtime.md");
  const semanticPath = join(source, "semantic.json");
  const next = join(data, "active.next");
  const active = join(data, "active");
  const previous = join(data, "active.previous");

  if (recoverActivation(source, next, active, previous)) {
    const { manifest } = await validateStagedBundle(active, name);
    if (manifest.state === "approved") transitionBundleState(active, "approved", "active");
    else if (manifest.state !== "active") {
      throw new Error(`Cannot recover activation from bundle state ${manifest.state}.`);
    }
    rmSync(previous, { recursive: true, force: true });
    console.log(`Recovered completed activation: ${name}`);
    return;
  }
  const { manifest, profile } = await validateStagedBundle(source, name);
  if (manifest.state !== "approved") {
    throw new Error(`Dataset must be approved before activation; current bundle state is ${manifest.state}.`);
  }
  const semantic = JSON.parse(readFileSync(semanticPath, "utf8")) as Record<string, unknown>;
  if (semantic.schema_version !== 1) throw new Error("Activation requires semantic.json schema_version 1.");
  await validateApprovedSemantic(semantic, profile);
  if (Buffer.byteLength(`${readFileSync(runtimeMarkdown, "utf8")}\n${readFileSync(semanticPath, "utf8")}`) > 12_000) {
    throw new Error("Dataset guide is larger than the 12 KB runtime limit.");
  }
  await quickCheckDatabase(database);

  renameSync(source, next);
  try {
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(active)) renameSync(active, previous);
    renameSync(next, active);
    transitionBundleState(active, "approved", "active");
  } catch (error) {
    if (!existsSync(next) && !existsSync(source) && existsSync(active)) renameSync(active, source);
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
  console.log(`Database: ${join(active, DATABASE_NAME)}`);
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
    await activateDataset(requested);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
