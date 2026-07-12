import assert from "node:assert/strict";
import { prepareReadOnlyQuery, validateQueryPlan } from "../lib/queryRunner";

assert.doesNotThrow(() =>
  validateQueryPlan([
    { detail: "SCAN order_reviews" },
    { detail: "SEARCH order_items USING INDEX idx_order_items_order_id" },
  ]),
);

assert.throws(
  () =>
    validateQueryPlan([
      { detail: "SCAN order_reviews" },
      { detail: "CORRELATED SCALAR SUBQUERY 1" },
    ]),
  /JOINs/,
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

console.log("queryRunner tests passed");
