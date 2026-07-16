import assert from "node:assert/strict";
import { generateAndRunQuery } from "../lib/generatedQuery";
import type { SqlCorrection } from "../lib/llmSql";
import type { QueryResult } from "../lib/queryRunner";
import {
  privacyRefusalForQuestion,
  privacyRefusalForSql,
  type PrivacyCatalog,
} from "../lib/privacySafety";

const privacyCatalog: PrivacyCatalog = {
  llmPolicy: { maskIdentifiers: true },
  tables: {
    customers: {
      columns: {
        customer_id: { privacy: { classification: "identifier" } },
        age: { privacy: { classification: "quasi_identifier" } },
        status: { privacy: { classification: "none" } },
      },
    },
  },
};

assert.match(
  privacyRefusalForQuestion("List customer_id and exact age.", privacyCatalog) ?? "",
  /Privacy/,
);
assert.match(
  privacyRefusalForSql("SELECT customer_id, age FROM customers", privacyCatalog) ?? "",
  /Privacy/,
);
assert.equal(
  privacyRefusalForSql(
    "SELECT CASE WHEN age < 30 THEN 'young' ELSE 'other' END age_band, COUNT(*) n FROM customers GROUP BY age_band",
    privacyCatalog,
  ),
  undefined,
);

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
assert.equal(repaired.sqlAttempts?.length, 1);
assert.deepEqual(corrections[1], {
  sql: generated[0],
  error: "[execution:1] ambiguous column name: product_id",
  attempt: 2,
});

const qualityCorrections: SqlCorrection[] = [];
const qualityBrief = {
  objective: "Revenue by month",
  metric: "revenue",
  grain: "one row per month",
  dimensions: ["month"],
  outputColumns: ["month", "revenue"],
  filters: [],
};
const qualityRepaired = await generateAndRunQuery(
  "Revenue by month",
  async (_question, correction) => {
    if (correction) {
      qualityCorrections.push(correction);
      return "SELECT month, SUM(revenue) revenue FROM facts GROUP BY month";
    }
    return {
      intent: "query",
      brief: qualityBrief,
      sql: "SELECT month, revenue FROM facts",
    };
  },
  (sql) => sql.includes("GROUP BY")
    ? { sql, columns: ["month", "revenue"], rows: [{ month: "2024-01", revenue: 30 }], truncated: false }
    : {
        sql,
        columns: ["month", "revenue"],
        rows: [{ month: "2024-01", revenue: 10 }, { month: "2024-01", revenue: 20 }],
        truncated: false,
      },
);
assert.equal(qualityRepaired.intent, "query");
assert.match(qualityCorrections[0].error, /^\[quality:1\].*duplicate rows/);
assert.deepEqual(qualityCorrections[0].brief, qualityBrief);

const clarification = await generateAndRunQuery(
  "best product",
  async () => ({ intent: "clarification", message: "Define best." }),
);
assert.deepEqual(
  { intent: clarification.intent, message: "message" in clarification ? clarification.message : "" },
  { intent: "clarification", message: "Define best." },
);

await assert.rejects(
  () => generateAndRunQuery("broken", async () => "SELECT broken", () => {
    throw new Error("no such column: broken");
  }),
  /\[execution:2\] no such column/,
);

console.log("generatedQuery tests passed");
