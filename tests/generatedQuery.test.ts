import assert from "node:assert/strict";
import { generateAndRunQuery } from "../lib/generatedQuery";
import type { QueryResult } from "../lib/queryRunner";

const corrections: unknown[] = [];
const generated = ["SELECT product_id FROM products JOIN order_items", "SELECT p.product_id FROM products p"];
const output: QueryResult = {
  sql: generated[1],
  columns: ["product_id"],
  rows: [{ product_id: "p1" }],
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

assert.equal(repaired.result, output);
assert.deepEqual(corrections[1], {
  sql: generated[0],
  error: "ambiguous column name: product_id",
});

console.log("generatedQuery tests passed");
