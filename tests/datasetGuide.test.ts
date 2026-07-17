import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join } from "node:path";
import { getDatasetGuide, getSemanticClarification } from "../lib/datasetGuide";

assert.match(getDatasetGuide(), /No dataset-specific semantics|./);
process.env.ACTIVE_DATASET_GUIDE_PATHS = ["docs/datasets/olist.semantic.json"].join(delimiter);
assert.match(getDatasetGuide(), /"forecasting": "unsupported/);

const directory = mkdtempSync(join(tmpdir(), "dataset-guide-"));
try {
  const database = join(directory, "database.duckdb");
  writeFileSync(database, "placeholder");
  writeFileSync(join(directory, "dataset.runtime.md"), "custom sibling guide");
  writeFileSync(join(directory, "semantic.json"), JSON.stringify({ schema_version: 1, status: "approved" }));
  delete process.env.ACTIVE_DATASET_GUIDE_PATHS;
  process.env.ACTIVE_DATABASE_PATH = database;
  assert.match(getDatasetGuide(), /custom sibling guide/);

  writeFileSync(join(directory, "semantic.json"), JSON.stringify({
    schema_version: 1,
    status: "approved",
    analysis_policy: { clarification_rules: [{ any: ["best customer"], message: "Define the metric." }] },
  }));
  assert.equal(getSemanticClarification("Who is the best customer?"), "Define the metric.");

  const semantic = join(directory, "semantic.json");
  writeFileSync(semantic, JSON.stringify({
    schema_version: 1,
    status: "approved",
    relationships: [],
    relationship_candidates: [{ from: "poison.source", to: "poison.target" }],
    measures: { confirmed_count: { expression: "COUNT(*)" } },
    measure_candidates: [{ name: "poison_measure" }],
    generation_error: "provider secret",
  }));
  process.env.ACTIVE_DATASET_GUIDE_PATHS = semantic;
  const guide = getDatasetGuide();
  assert.match(guide, /confirmed_count/);
  assert.doesNotMatch(guide, /poison|provider secret/);
} finally {
  delete process.env.ACTIVE_DATABASE_PATH;
  rmSync(directory, { recursive: true, force: true });
}

console.log("datasetGuide tests passed");
