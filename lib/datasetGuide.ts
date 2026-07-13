import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

function getGuidePaths() {
  const configured = process.env.ACTIVE_DATASET_GUIDE_PATHS;
  if (!configured) {
    return [join(process.cwd(), "data", "dataset.md"), join(process.cwd(), "data", "semantic.json")];
  }
  return configured.split(delimiter).filter(Boolean).map((path) =>
    isAbsolute(path) ? path : resolve(process.cwd(), path),
  );
}

export function getDatasetGuide() {
  const guide = getGuidePaths()
    .filter(existsSync)
    .map((path) => readFileSync(path, "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(guide) > 12_000) {
    throw new Error("Active dataset guide is larger than 12 KB.");
  }
  return guide || "No dataset-specific semantics are installed. Use only the database schema and ask for clarification when a business measure is ambiguous.";
}
