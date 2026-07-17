import assert from "node:assert/strict";
import { prepareReadOnlyQuery } from "../lib/queryRunner";

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

console.log("queryRunner tests passed");
