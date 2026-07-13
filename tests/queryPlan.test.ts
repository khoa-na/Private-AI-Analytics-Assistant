import assert from "node:assert/strict";
import { parseAnalysisPlan } from "../lib/llmQueryPlan";

assert.equal(
  parseAnalysisPlan(JSON.stringify({
    intent: "analysis",
    requirements: [
      { measure: { name: "revenue", definition: "sum price" }, grain: ["month"], filters: [] },
      { measure: { name: "orders", definition: "count orders" }, grain: ["month"], filters: [] },
    ],
  }), "Revenue and orders by month"),
  undefined,
);

const multi = parseAnalysisPlan(JSON.stringify({
  intent: "analysis",
  requirements: [
    { measure: { name: "revenue", definition: "sum price" }, grain: ["month"], filters: [] },
    { measure: { name: "reviews", definition: "average score" }, grain: ["category"], filters: [] },
  ],
}), "Compare revenue and reviews");
assert.equal(multi?.intent, "multi_query");
if (multi?.intent !== "multi_query") throw new Error("Expected multi-query plan.");
assert.equal(multi.steps.length, 2);

assert.equal(
  parseAnalysisPlan('{"intent":"analysis","requirements":[{"measure":"row count"}]}', "Count rows"),
  undefined,
);
assert.equal(
  parseAnalysisPlan('{"intent":"query","requirements":{"metric":"row count","dimensions":"table"}}', "Count rows"),
  undefined,
);
assert.equal(
  parseAnalysisPlan('Result:\n```json\n{"intent":"analysis","requirements":[{"measure":"row count"}]}\n```', "Count rows"),
  undefined,
);
assert.throws(
  () => parseAnalysisPlan('{"intent":"analysis","requirements":[{"measure":""}]}', "Count rows"),
  /requirements\[0\]\.measure/,
);

assert.deepEqual(
  parseAnalysisPlan('{"intent":"clarification","message":"Define revenue."}', "Revenue"),
  { intent: "clarification", message: "Define revenue." },
);
assert.throws(
  () => parseAnalysisPlan('{"intent":"analysis","requirements":[]}', "Revenue"),
  /requirements/,
);

console.log("queryPlan tests passed");
