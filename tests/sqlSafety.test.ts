import assert from "node:assert/strict";
import { extractSqlFromModelOutput } from "../lib/sqlExtraction";
import { validateReadOnlySql, withDefaultLimit } from "../lib/sqlSafety";

assert.equal(validateReadOnlySql("SELECT * FROM orders;"), "SELECT * FROM orders");
assert.equal(
  withDefaultLimit("SELECT order_id FROM orders"),
  "SELECT order_id FROM orders LIMIT 1000",
);
assert.throws(() => validateReadOnlySql("DELETE FROM orders"), /read-only/);
assert.throws(() => validateReadOnlySql("SELECT * FROM orders; DROP TABLE orders"), /read-only/);
assert.throws(() => validateReadOnlySql("SELECT 1; SELECT 2"), /single SELECT/);
assert.equal(
  validateReadOnlySql("SELECT * FROM orders CROSS JOIN customers"),
  "SELECT * FROM orders CROSS JOIN customers",
);
assert.equal(
  validateReadOnlySql("SELECT RANK() OVER (ORDER BY order_id) FROM orders"),
  "SELECT RANK() OVER (ORDER BY order_id) FROM orders",
);
assert.equal(
  extractSqlFromModelOutput('{"sql":"SELECT * FROM orders"}'),
  "SELECT * FROM orders",
);
assert.equal(
  extractSqlFromModelOutput("```sql\nSELECT * FROM orders;\n```"),
  "SELECT * FROM orders;",
);
assert.equal(
  extractSqlFromModelOutput("Here is the query:\nSELECT * FROM orders;"),
  "SELECT * FROM orders;",
);
assert.equal(
  extractSqlFromModelOutput(
    "SELECT broken FROM;<｜end▁of▁thinking｜>\nSELECT order_id FROM orders;",
  ),
  "SELECT order_id FROM orders;",
);

console.log("sqlSafety tests passed");
