import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transitionBundleState, validateStagedBundle, writeDatasetBundle } from "../lib/datasetBundle";
import { createDatasetDraft, validateApprovedSemantic } from "../lib/datasetDraft";
import { buildColumnEvidence, DEFAULT_LLM_POLICY } from "../lib/datasetEvidence";
import { profileDatabase, refreshDataset, stageDataset } from "../lib/datasetImport";
import { validateMeasureDefinition } from "../lib/datasetMeasure";
import { reviewDataset } from "../lib/datasetReview";
import { activateDataset } from "../scripts/activate-dataset";

const root = mkdtempSync(join(tmpdir(), "dataset-import-"));
const source = join(root, "sales");
mkdirSync(source);
mkdirSync(join(source, "orders"));
writeFileSync(join(source, "customers.csv"), "customer_id,name,age,FN\n1,Alice,24,1\n2,Bob,41,\n");
writeFileSync(join(source, "events.csv"), `event_id,value\n${Array.from({ length: 10_001 }, (_, index) => `${index + 1},${index}`).join("\n")}\n`);
writeFileSync(join(source, "orders", "january.tsv"), "order_id\tcustomer_id\tamount\tordered_at\n10\t1\t12.5\t2024-01-10\n");
writeFileSync(join(source, "orders", "february.tsv"), "order_id\tcustomer_id\tamount\tordered_at\n11\t1\t4\t2024-02-11\n");
writeFileSync(join(source, "dataset.json"), JSON.stringify({
  name: "sales-prod",
  analysisHints: ["Treat amount units as unconfirmed."],
  llmPolicy: { sendExamples: true, sendFreeTextExamples: false, maskIdentifiers: true, maxExampleLength: 40 },
  tables: [
    { name: "customers", format: "csv", sources: ["customers.csv"], primaryKey: ["customer_id"] },
    { name: "events", format: "csv", sources: ["events.csv"] },
    { name: "orders", format: "tsv", sources: ["orders/*.tsv"], primaryKey: ["order_id"], sourceColumn: "source_file", indexes: [["customer_id"]] },
  ],
}));
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const reviewModel = process.env.OPENAI_REVIEW_MODEL;
const fetch = globalThis.fetch;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;

try {
  const data = join(root, "data");
  const notes = buildColumnEvidence({
    table: "patients",
    name: "notes",
    type: "TEXT",
    values: ["patient HIV status: positive"],
    profiledRows: 1,
    rowCount: 1,
    declaredPrimaryKey: false,
    policy: DEFAULT_LLM_POLICY,
  });
  assert.equal(notes.semanticType, "free_text");
  assert.deepEqual(notes.examples, []);
  const ssn = buildColumnEvidence({
    table: "people",
    name: "ssn",
    type: "TEXT",
    values: ["123-45-6789"],
    profiledRows: 1,
    rowCount: 1,
    declaredPrimaryKey: false,
    policy: DEFAULT_LLM_POLICY,
  });
  assert.equal(ssn.privacy.classification, "direct_identifier");
  assert.deepEqual(ssn.examples, []);
  const phone = buildColumnEvidence({
    table: "people",
    name: "phone",
    type: "INTEGER",
    values: [84900000001, 84900000002],
    profiledRows: 2,
    rowCount: 2,
    declaredPrimaryKey: false,
    policy: DEFAULT_LLM_POLICY,
  });
  assert.equal(phone.min, undefined);
  assert.equal(phone.max, undefined);

  const overlapSource = join(data, "staging", "overlap");
  mkdirSync(overlapSource, { recursive: true });
  writeFileSync(join(overlapSource, "raw.csv"), "id\n1\n");
  await assert.rejects(stageDataset(overlapSource, join(data, "staging")), /must not overlap/);
  assert.ok(existsSync(join(overlapSource, "raw.csv")));

  const atomicSource = join(root, "atomic");
  mkdirSync(atomicSource);
  writeFileSync(join(atomicSource, "facts.csv"), "id,value\n1,old\n");
  const atomic = await stageDataset(atomicSource, join(data, "staging"));
  writeFileSync(join(atomicSource, "facts.csv"), "id,value,value\n1,left,right\n");
  await assert.rejects(stageDataset(atomicSource, join(data, "staging")), /duplicate column headers/);
  const preserved = new DatabaseSync(join(atomic.directory, "database.sqlite"), { readOnly: true });
  assert.equal((preserved.prepare("SELECT value FROM facts").get() as { value: string }).value, "old");
  preserved.close();

  const walPath = join(root, "wal.sqlite");
  const walDb = new DatabaseSync(walPath);
  walDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE wal_rows (id INTEGER PRIMARY KEY); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO wal_rows VALUES (1)");
  const walStage = await stageDataset(walPath, join(data, "staging"));
  const walCopy = new DatabaseSync(join(walStage.directory, "database.sqlite"), { readOnly: true });
  assert.equal((walCopy.prepare("SELECT COUNT(*) AS count FROM wal_rows").get() as { count: number }).count, 1);
  walCopy.close();
  walDb.close();

  const keyPath = join(root, "keys.sqlite");
  const keyDb = new DatabaseSync(keyPath);
  keyDb.exec("CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b)); INSERT INTO parent VALUES (1, 1), (1, 2), (2, 1); CREATE TABLE sparse (id INTEGER PRIMARY KEY)");
  const sparseInsert = keyDb.prepare("INSERT INTO sparse VALUES (?)");
  keyDb.exec("BEGIN");
  for (let index = 1; index <= 10_001; index += 1) sparseInsert.run(index * 1000);
  keyDb.exec("COMMIT");
  keyDb.close();
  const keyProfile = profileDatabase(keyPath, "keys");
  assert.equal(keyProfile.tables.find(({ name }) => name === "parent")?.columns.find(({ name }) => name === "a")?.candidateKey, false);
  assert.equal(keyProfile.tables.find(({ name }) => name === "sparse")?.profiledRows, 10_000);
  assert.equal(keyProfile.tables.find(({ name }) => name === "sparse")?.profileMethod, "head");

  const { directory, profile } = await stageDataset(source, join(data, "staging"));
  assert.equal(profile.dataset, "sales-prod");
  assert.equal(profile.tables.length, 3);
  assert.equal(profile.tables.find(({ name }) => name === "events")?.rowCount, 10_001);
  assert.equal(profile.tables.find(({ name }) => name === "events")?.profiledRows, 10_000);
  assert.equal(profile.tables.find(({ name }) => name === "events")?.profileMethod, "systematic_rowid");
  assert.equal(profile.tables.find(({ name }) => name === "events")?.columns.find(({ name }) => name === "event_id")?.semanticType, "identifier");
  assert.deepEqual(profile.tables.find(({ name }) => name === "events")?.columns.find(({ name }) => name === "event_id")?.examples, []);
  assert.equal(profile.tables.find(({ name }) => name === "customers")?.columns.find(({ name }) => name === "age")?.semanticType, "number");
  assert.equal(profile.tables.find(({ name }) => name === "customers")?.columns.find(({ name }) => name === "name")?.privacy.classification, "direct_identifier");
  assert.deepEqual(profile.tables.find(({ name }) => name === "customers")?.columns.find(({ name }) => name === "name")?.examples, []);
  assert.equal(
    profile.tables.find(({ name }) => name === "events")?.columns.find(({ name }) => name === "value")?.max,
    10_000,
  );
  assert.equal(profile.tables.find(({ name }) => name === "orders")?.rowCount, 2);
  assert.equal(profile.tables.find(({ name }) => name === "orders")?.profiledRows, 2);
  assert.equal(
    profile.tables.find(({ name }) => name === "orders")?.columns.find(({ name }) => name === "amount")?.type,
    "REAL",
  );
  const orderedAt = profile.tables.find(({ name }) => name === "orders")?.columns.find(({ name }) => name === "ordered_at");
  assert.equal(orderedAt?.semanticType, "date");
  assert.equal(orderedAt?.minValue, "2024-01-10");
  assert.equal(orderedAt?.maxValue, "2024-02-11");
  assert.ok(profile.relationshipCandidates.some(
    ({ from, to }) => from === "orders.customer_id" && to === "customers.customer_id",
  ));
  const draft = await createDatasetDraft(profile);
  assert.equal(draft.generatedBy, "deterministic");
  assert.equal(draft.generationError, undefined);
  assert.match(draft.markdown, /orders\.customer_id -> customers\.customer_id/);
  assert.match(draft.markdown, /Treat amount units as unconfirmed/);
  assert.match(draft.markdown, /identifiers masked: true/);
  const catalog = JSON.parse(draft.catalogJson);
  assert.equal(catalog.tables.events.columns.event_id.privacy.examplesRedacted, true);
  assert.equal(catalog.tables.orders.columns.ordered_at.statistics.minValue, "2024-01-10");
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL = "test";
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    overview: "AI candidate overview.",
    tableDescriptions: { orders: "AI candidate orders description." },
    columnDescriptions: { "customers.FN": "Fashion newsletter subscription." },
    measureCandidates: [
      { name: "total_amount", description: "Total amount.", grain: "orders", baseTable: "orders", expression: "SUM(orders.amount)", columns: ["orders.amount"] },
      { name: "monthly_amount", description: "Monthly amount.", grain: "month", baseTable: "orders", expression: "SUM(orders.amount)", columns: ["orders.amount"] },
    ],
  }) } }] }));
  const aiDraft = await createDatasetDraft(profile);
  assert.equal(aiDraft.generatedBy, "ai");
  assert.equal(JSON.parse(aiDraft.semanticJson).measure_candidates.length, 1);
  assert.equal(JSON.parse(aiDraft.catalogJson).tables.customers.columns.FN.description.status, "unknown");
  assert.doesNotMatch(aiDraft.runtimeMarkdown, /AI candidate overview|AI candidate orders description/);
  assert.equal(JSON.parse(draft.semanticJson).schema_version, 1);
  assert.equal(JSON.parse(draft.semanticJson).status, "draft");
  assert.equal(JSON.parse(draft.semanticJson).entities.customers.provenance.source, "database_constraint");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "test AI failure" } }), { status: 500 });
  const fallback = await createDatasetDraft(profile);
  assert.equal(fallback.generatedBy, "deterministic");
  assert.equal(fallback.generationError, "test AI failure");
  assert.equal(JSON.parse(fallback.semanticJson).generation_error, "test AI failure");
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  globalThis.fetch = fetch;

  const stagedDatabase = join(directory, "database.sqlite");
  const stagedDb = new DatabaseSync(stagedDatabase);
  assert.ok(stagedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx:orders:customer_id'").get());
  stagedDb.exec('DROP INDEX "idx:orders:customer_id"');
  stagedDb.exec('CREATE INDEX "idx:orders:stale" ON orders(order_id)');
  stagedDb.close();
  const refreshed = refreshDataset(source, join(data, "staging"));
  assert.equal(refreshed.profile.tables.find(({ name }) => name === "events")?.rowCount, 10_001);
  const refreshedDb = new DatabaseSync(stagedDatabase, { readOnly: true });
  assert.ok(refreshedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx:orders:customer_id'").get());
  assert.equal(refreshedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx:orders:stale'").get(), undefined);
  refreshedDb.close();

  const semantic = JSON.parse(draft.semanticJson);
  semantic.status = "approved";
  const totalAmount = {
    name: "total_amount",
    description: "Sum of recorded order amounts.",
    grain: "selected dimensions",
    baseTable: "orders",
    expression: "SUM(orders.amount)",
    columns: ["orders.amount"],
    provenance: { source: "human_confirmation", evidence: ["Test measure definition"] },
  };
  const validation = validateMeasureDefinition(totalAmount, profile);
  assert.equal(validation.status, "passed");
  assert.equal(validateMeasureDefinition({ ...totalAmount, expression: "SUM(amount)" }, profile).status, "failed");
  assert.equal(validateMeasureDefinition({ ...totalAmount, expression: "SUM((SELECT amount FROM orders))" }, profile).status, "failed");
  assert.equal(validateMeasureDefinition({ ...totalAmount, expression: "SUM(orders.amount) / 0" }, profile).status, "failed");
  assert.equal(validateMeasureDefinition({ ...totalAmount, expression: "SUM(orders.amount) * 1e999" }, profile).status, "failed");
  assert.equal(validateMeasureDefinition({ ...totalAmount, expression: "SUM(orders.amount) + random()" }, profile).status, "failed");
  semantic.measures.total_amount = { ...totalAmount, validation };
  semantic.relationships = [semantic.relationship_candidates[0]];
  assert.doesNotThrow(() => validateApprovedSemantic(semantic, profile));
  assert.throws(
    () => validateApprovedSemantic({ ...semantic, dataset: "wrong-dataset" }, profile),
    /dataset or dialect/,
  );
  semantic.relationships = [{
    from: "orders.missing",
    to: "customers.customer_id",
    provenance: { source: "human_confirmation", evidence: ["Test relationship"] },
  }];
  assert.throws(() => validateApprovedSemantic(semantic, profile), /valid table\.column/);
  semantic.relationships = [];
  const reviewDraft = JSON.parse(draft.semanticJson);
  reviewDraft.measure_candidates = [{
    ...totalAmount,
    status: "needs_review",
    provenance: { source: "llm_inference", evidence: ["orders.amount"] },
    validation,
  }];
  writeDatasetBundle(directory, {
    "dataset-profile.json": `${JSON.stringify(refreshed.profile, null, 2)}\n`,
    "dataset-catalog.json": draft.catalogJson,
    "dataset.md": draft.markdown,
    "dataset.runtime.md": draft.runtimeMarkdown,
    "semantic.json": `${JSON.stringify(reviewDraft, null, 2)}\n`,
  }, {
    dataset: profile.dataset,
    sourcePath: source,
    generatedBy: draft.generatedBy,
  });
  assert.ok(existsSync(join(directory, "bundle-manifest.json")));
  assert.equal(validateStagedBundle(directory, "sales-prod").manifest.state, "draft");
  assert.throws(() => transitionBundleState(directory, "draft", "active"), /Invalid bundle state transition/);

  const tamperedDb = new DatabaseSync(stagedDatabase);
  tamperedDb.exec("CREATE TABLE bundle_tamper (value TEXT)");
  tamperedDb.close();
  assert.throws(() => activateDataset("sales-prod", data), /database\.sqlite no longer matches/);
  const restoredDb = new DatabaseSync(stagedDatabase);
  restoredDb.exec("DROP TABLE bundle_tamper");
  restoredDb.close();
  writeDatasetBundle(directory, {
    "dataset-profile.json": `${JSON.stringify(refreshed.profile, null, 2)}\n`,
    "dataset-catalog.json": draft.catalogJson,
    "dataset.md": draft.markdown,
    "dataset.runtime.md": draft.runtimeMarkdown,
    "semantic.json": `${JSON.stringify(reviewDraft, null, 2)}\n`,
  }, {
    dataset: profile.dataset,
    sourcePath: source,
    generatedBy: draft.generatedBy,
  });

  writeFileSync(join(directory, "dataset-catalog.json"), `${draft.catalogJson}\n`);
  assert.throws(() => activateDataset("sales-prod", data), /dataset-catalog\.json no longer matches/);
  writeFileSync(join(directory, "dataset-catalog.json"), draft.catalogJson);
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_REVIEW_MODEL = "review-test";
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body);
    assert.match(body, /SUM\(orders\.amount\)/);
    assert.doesNotMatch(body, /total_amount|Sum of recorded order amounts|selected dimensions/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reviews: [{
      id: "m1",
      decision: "approve",
      evidence_ids: ["expression:m1", "column:orders.amount"],
    }] }) } }] }));
  };
  const report = await reviewDataset(directory, "sales-prod");
  assert.equal(report.decision, "approved");
  assert.equal(report.relationships.filter(({ decision }) => decision === "approved").length, 1);
  assert.equal(report.measures.filter(({ decision }) => decision === "approved").length, 1);
  const reviewedSemantic = readFileSync(join(directory, "semantic.json"), "utf8");
  const reviewedReport = readFileSync(join(directory, "review-report.json"), "utf8");
  assert.equal(JSON.parse(reviewedSemantic).status, "approved");
  assert.equal(JSON.parse(reviewedSemantic).measures.orders_amount_sum.description, "Sum of recorded values in orders.amount.");
  assert.equal(JSON.parse(reviewedSemantic).measures.orders_amount_sum.grain, "Selected dimensions over database rows in orders.");
  assert.equal(validateStagedBundle(directory, "sales-prod").manifest.review?.model, "review-test");
  writeFileSync(join(directory, "semantic.json"), `${reviewedSemantic}\n`);
  assert.throws(() => activateDataset("sales-prod", data), /semantic\.json no longer matches/);
  writeFileSync(join(directory, "semantic.json"), reviewedSemantic);
  writeFileSync(join(directory, "review-report.json"), `${reviewedReport}\n`);
  assert.throws(() => activateDataset("sales-prod", data), /review-report\.json no longer matches/);
  writeFileSync(join(directory, "review-report.json"), reviewedReport);

  const interrupted = join(data, "active.next");
  const previous = join(data, "active.previous");
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "old.txt"), "old");
  renameSync(directory, interrupted);
  activateDataset("sales-prod", data);
  assert.ok(existsSync(join(data, "active", "database.sqlite")));
  assert.ok(existsSync(join(data, "active", "bundle-manifest.json")));
  assert.ok(!existsSync(join(data, "active", "old.txt")));
  assert.ok(!existsSync(join(data, "active.previous")));
  assert.ok(!existsSync(join(data, "active.next")));
  assert.ok(!existsSync(directory));
  const sealedManifest = JSON.parse(readFileSync(join(data, "active", "bundle-manifest.json"), "utf8"));
  assert.equal(sealedManifest.state, "active");
  assert.equal(typeof sealedManifest.sealed_at, "string");
  assert.throws(() => transitionBundleState(join(data, "active"), "active", "draft"), /Invalid bundle state transition/);
  mkdirSync(join(data, "active.previous"));
  writeFileSync(join(data, "active.previous", "old.txt"), "old");
  activateDataset("sales-prod", data);
  assert.ok(!existsSync(join(data, "active.previous")));
  const activeDb = new DatabaseSync(join(data, "active", "database.sqlite"), { readOnly: true });
  const sourceFiles = activeDb.prepare("SELECT source_file FROM orders ORDER BY order_id").all() as Array<{ source_file: string }>;
  activeDb.close();
  assert.deepEqual(sourceFiles.map(({ source_file }) => source_file), ["orders/january.tsv", "orders/february.tsv"]);
} finally {
  if (apiKey) process.env.OPENAI_API_KEY = apiKey;
  else delete process.env.OPENAI_API_KEY;
  if (model) process.env.OPENAI_MODEL = model;
  else delete process.env.OPENAI_MODEL;
  if (reviewModel) process.env.OPENAI_REVIEW_MODEL = reviewModel;
  else delete process.env.OPENAI_REVIEW_MODEL;
  globalThis.fetch = fetch;
  rmSync(root, { recursive: true, force: true });
}

console.log("datasetImport tests passed");
