import { readFileSync } from "node:fs";
import { join } from "node:path";

const GUIDES: Record<string, string> = {
  olist: join(process.cwd(), "docs", "datasets", "olist.md"),
};
export const DATASET_IDS = Object.freeze(Object.keys(GUIDES));

export function getDatasetGuide(dataset: string) {
  const path = GUIDES[dataset];
  if (!path) throw new Error(`Unknown dataset: ${dataset}`);

  const guide = readFileSync(path, "utf8").trim();
  if (Buffer.byteLength(guide) > 12_000) {
    throw new Error(`Dataset guide is too large: ${dataset}`);
  }
  return guide;
}
