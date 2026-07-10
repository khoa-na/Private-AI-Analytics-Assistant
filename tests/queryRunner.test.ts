import assert from "node:assert/strict";
import { validateQueryPlan } from "../lib/queryRunner";

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

console.log("queryRunner tests passed");
