import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DATABASE_NAME, validateStagedBundle, writeDatasetBundle } from "../lib/datasetBundle";
import { createDatasetDraft, validateApprovedSemantic } from "../lib/datasetDraft";
import { stageDataset } from "../lib/datasetImport";
import { validateMeasureDefinition } from "../lib/datasetMeasure";
import { reviewDataset } from "../lib/datasetReview";
import { activateDataset } from "../scripts/activate-dataset";

const root = mkdtempSync(join(tmpdir(), "duckdb-import-"));
const source = join(root, "source");
const data = join(root, "data");
mkdirSync(join(source, "orders"), { recursive: true });
writeFileSync(join(source, "customers.csv"), "customer_id,name\nc1,Alice\nc2,Bob\n");
writeFileSync(join(source, "orders", "part-1.tsv"), "order_id\tcustomer_id\tamount\no1\tc1\t10\n");
writeFileSync(join(source, "orders", "part-2.tsv"), "order_id\tcustomer_id\tamount\no2\tc2\t20\n");

const parquet = join(source, "events.parquet").replaceAll("\\", "/").replaceAll("'", "''");
const fixture = await DuckDBInstance.create(":memory:");
const fixtureDb = await fixture.connect();
await fixtureDb.run(`COPY (SELECT 1 AS event_id, 'c1' AS customer_id) TO '${parquet}' (FORMAT PARQUET)`);
fixtureDb.closeSync();
fixture.closeSync();

writeFileSync(join(source, "dataset.json"), JSON.stringify({
  name: "sales-prod",
  analysisHints: ["amount is the recorded order amount"],
  clarificationRules: [{ any: ["best customer"], message: "Define the customer metric and period." }],
  tables: [
    { name: "customers", sources: ["customers.csv"], format: "csv", primaryKey: ["customer_id"] },
    { name: "orders", sources: ["orders/*.tsv"], format: "tsv", sourceColumn: "source_file" },
    { name: "events", sources: ["events.parquet"], format: "parquet" },
  ],
}, null, 2));

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;

try {
  const { directory, profile } = await stageDataset(source, join(data, "staging"));
  assert.ok(existsSync(join(directory, DATABASE_NAME)));
  assert.deepEqual(profile.tables.map(({ name }) => name), ["customers", "events", "orders"]);
  assert.equal(profile.tables.find(({ name }) => name === "orders")?.rowCount, 2);
  assert.equal(profile.tables.find(({ name }) => name === "events")?.rowCount, 1);
  assert.ok(profile.relationshipCandidates.some(({ from, to }) =>
    from === "orders.customer_id" && to === "customers.customer_id"));
  assert.equal(profile.clarificationRules?.[0].message, "Define the customer metric and period.");

  const measure = await validateMeasureDefinition({
    baseTable: "orders",
    expression: "SUM(orders.amount)",
    columns: ["orders.amount"],
  }, profile);
  assert.equal(measure.status, "passed", measure.errors.join(" "));
  assert.equal((await validateMeasureDefinition({
    baseTable: "orders",
    expression: "SUM(orders.amount) / 0",
    columns: ["orders.amount"],
  }, profile)).status, "failed");

  const draft = await createDatasetDraft(profile, {
    dataset: "sales-prod",
    status: "approved",
    relationships: [],
    measures: {},
    analysis_policy: { preserved_rule: "keep reviewed semantics across database rebuilds" },
  });
  assert.equal(JSON.parse(draft.semanticJson).analysis_policy.preserved_rule, "keep reviewed semantics across database rebuilds");
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
  });
  assert.equal((await validateStagedBundle(directory, "sales-prod")).manifest.state, "draft");

  const report = await reviewDataset(directory, "sales-prod", { useAi: false });
  assert.equal(report.decision, "approved");
  const approved = JSON.parse(readFileSync(join(directory, "semantic.json"), "utf8"));
  await assert.doesNotReject(() => validateApprovedSemantic(approved, profile));

  await activateDataset("sales-prod", data);
  assert.ok(existsSync(join(data, "active", DATABASE_NAME)));
  assert.equal((await validateStagedBundle(join(data, "active"), "sales-prod")).manifest.state, "active");
} finally {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  rmSync(root, { recursive: true, force: true });
}

console.log("datasetImport tests passed");
