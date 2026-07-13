import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "active-dataset-"));
const path = join(directory, "custom.db");
const db = new DatabaseSync(path);
db.exec("CREATE TABLE inventory (sku TEXT PRIMARY KEY, quantity INTEGER)");
db.exec("INSERT INTO inventory VALUES ('A-1', 7)");
db.close();
process.env.ACTIVE_DATABASE_PATH = path;

try {
  const { getSchemaText } = await import("../lib/schema");
  const { getDb } = await import("../lib/db");
  const { runReadOnlyQuery } = await import("../lib/queryRunner");
  assert.match(getSchemaText(), /inventory\(sku TEXT PRIMARY KEY, quantity INTEGER\)/);
  const rows = runReadOnlyQuery("SELECT sku, quantity FROM inventory").rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sku, "A-1");
  assert.equal(rows[0].quantity, 7);
  const protectedDb = getDb();
  try {
    assert.throws(
      () => protectedDb.prepare("ATTACH DATABASE ':memory:' AS injected"),
      /not authorized/,
    );
  } finally {
    protectedDb.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("activeDataset tests passed");
