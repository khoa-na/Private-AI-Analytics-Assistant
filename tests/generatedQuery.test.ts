import assert from "node:assert/strict";
import { generateAndRunQuery } from "../lib/generatedQuery";
import type { QueryResult } from "../lib/queryRunner";

const corrections: unknown[] = [];
const generated = ["SELECT product_id FROM products JOIN order_items", "SELECT p.product_id FROM products p"];
const output: QueryResult = {
  sql: generated[1],
  columns: ["product_id"],
  rows: [{ product_id: "p1" }],
  truncated: false,
};

const repaired = await generateAndRunQuery(
  "top products",
  async (_question, correction) => {
    corrections.push(correction);
    return generated[corrections.length - 1];
  },
  (sql) => {
    if (sql === generated[0]) throw new Error("ambiguous column name: product_id");
    return output;
  },
);

assert.equal(repaired.intent, "query");
if (repaired.intent !== "query") throw new Error("Expected query result.");
assert.equal(repaired.result, output);
assert.deepEqual(corrections[1], {
  sql: generated[0],
  error: "ambiguous column name: product_id",
});

const clarification = await generateAndRunQuery(
  "best product",
  async () => ({ intent: "clarification", message: "Define best." }),
);
assert.deepEqual(
  { intent: clarification.intent, message: "message" in clarification ? clarification.message : "" },
  { intent: "clarification", message: "Define best." },
);

console.log("generatedQuery tests passed");
