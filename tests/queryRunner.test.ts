import assert from "node:assert/strict";
import { prepareReadOnlyQuery, queryTimeoutMs } from "../lib/queryRunner";

assert.deepEqual(prepareReadOnlyQuery("SELECT * FROM orders", 1000), {
  displaySql: "SELECT * FROM orders LIMIT 1000",
  executionSql: "SELECT * FROM orders LIMIT 1001",
  limit: 1000,
});
assert.deepEqual(prepareReadOnlyQuery("SELECT * FROM orders LIMIT 5"), {
  displaySql: "SELECT * FROM orders LIMIT 5",
  executionSql: "SELECT * FROM orders LIMIT 5",
  limit: undefined,
});
assert.deepEqual(prepareReadOnlyQuery("SELECT * FROM orders LIMIT 5000", 1000), {
  displaySql: "SELECT * FROM (SELECT * FROM orders LIMIT 5000) LIMIT 1000",
  executionSql: "SELECT * FROM (SELECT * FROM orders LIMIT 5000) LIMIT 1001",
  limit: 1000,
});
process.env.DUCKDB_QUERY_TIMEOUT_MS = "1234";
assert.equal(queryTimeoutMs(), 1234);
delete process.env.DUCKDB_QUERY_TIMEOUT_MS;

console.log("queryRunner tests passed");
