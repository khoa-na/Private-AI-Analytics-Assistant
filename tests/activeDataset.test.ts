import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const directory = mkdtempSync(join(tmpdir(), "active-dataset-"));
const path = join(directory, "custom.duckdb");
const instance = await DuckDBInstance.create(path);
const setup = await instance.connect();
await setup.run("CREATE TABLE inventory (sku VARCHAR PRIMARY KEY, quantity INTEGER)");
await setup.run("INSERT INTO inventory VALUES ('A-1', 7)");
setup.closeSync();
instance.closeSync();
process.env.ACTIVE_DATABASE_PATH = path;

try {
  const { getSchemaText } = await import("../lib/schema");
  const { getDb } = await import("../lib/db");
  const { runReadOnlyQuery } = await import("../lib/queryRunner");
  assert.match(await getSchemaText(), /inventory\(sku VARCHAR PRIMARY KEY, quantity INTEGER\)/);
  const rows = (await runReadOnlyQuery("SELECT sku, quantity FROM inventory")).rows;
  assert.deepEqual(rows, [{ sku: "A-1", quantity: 7 }]);

  process.env.DUCKDB_THREADS = "invalid";
  await assert.rejects(() => getDb(), /DUCKDB_THREADS/);
  delete process.env.DUCKDB_THREADS;

  const protectedDb = await getDb();
  try {
    await assert.rejects(() => protectedDb.run("CREATE TABLE injected (id INTEGER)"), /read-only/i);
  } finally {
    protectedDb.closeSync();
  }
} finally {
  delete process.env.ACTIVE_DATABASE_PATH;
  rmSync(directory, { recursive: true, force: true });
}

console.log("activeDataset tests passed");
