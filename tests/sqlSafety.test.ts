import assert from "node:assert/strict";
import { validateReadOnlySql, withDefaultLimit } from "../lib/sqlSafety";

assert.equal(validateReadOnlySql("SELECT * FROM orders;"), "SELECT * FROM orders");
assert.equal(
  withDefaultLimit("SELECT order_id FROM orders"),
  "SELECT order_id FROM orders LIMIT 1000",
);
assert.throws(() => validateReadOnlySql("DELETE FROM orders"), /read-only/);
assert.throws(() => validateReadOnlySql("SELECT * FROM orders; DROP TABLE orders"), /read-only/);

console.log("sqlSafety tests passed");
