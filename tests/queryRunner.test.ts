import assert from "node:assert/strict";
import { prepareReadOnlyQuery, validateQueryPlan } from "../lib/queryRunner";

assert.doesNotThrow(() =>
  validateQueryPlan([
    { detail: "SCAN order_reviews" },
    { detail: "SEARCH order_items USING INDEX idx_order_items_order_id" },
  ]),
);

assert.throws(
  () => validateQueryPlan([{ detail: "CORRELATED SCALAR SUBQUERY 1" }]),
  /JOINs/,
);
assert.throws(
  () => validateQueryPlan([
    { detail: "SCAN t" },
    { detail: "SEARCH a USING INDEX idx_articles_id" },
    { detail: "USE TEMP B-TREE FOR DISTINCT" },
  ]),
  /too expensive/,
);
assert.doesNotThrow(() => validateQueryPlan([
  { detail: "SCAN CONSTANT ROW" },
  { detail: "SCAN facts" },
  { detail: "USE TEMP B-TREE FOR DISTINCT" },
]));
assert.doesNotThrow(
  () => validateQueryPlan([
    { detail: "MATERIALIZE deciles" },
    { detail: "SCAN deciles" },
    { detail: "SCAN deciles" },
  ]),
);

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
