import assert from "node:assert/strict";
import { explicitResultContract, generateAndRunQuery, sqlContractIssues } from "../lib/generatedQuery";
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

assert.deepEqual(sqlContractIssues("Return the seven-day average.", "SELECT ROUND(AVG(n), 2) value FROM facts"), [
  "Preserve full numeric precision; rounding was not requested.",
]);
assert.equal(sqlContractIssues("Return the MoM decrease.", "SELECT (value - prior) / prior AS change FROM facts").length, 1);
assert.equal(sqlContractIssues("Return the MoM row share change.", "SELECT part / total AS row_share FROM facts").length, 0);
assert.equal(sqlContractIssues("Audit values outside {0,1}.", "SELECT (SELECT COUNT(*) FROM t WHERE flag NOT IN (0,1) OR flag IS NULL) AS invalid_flag_rows").length, 1);
assert.equal(sqlContractIssues("Audit values outside {0,1}.", "SELECT COUNT(*) AS invalid_flag_rows FROM t WHERE flag IS NULL").length, 1);
assert.equal(sqlContractIssues(
  "Count missing identifiers and values outside {0,1} as separate metrics.",
  "SELECT (SELECT COUNT(*) FROM t WHERE id IS NULL) AS missing_ids, (SELECT COUNT(*) FROM t WHERE flag NOT IN (0,1) OR flag IS NULL) AS invalid_flag_rows",
).length, 1);
assert.equal(sqlContractIssues(
  "Count missing identifiers and values outside {0,1} as separate metrics.",
  "SELECT (SELECT COUNT(*) FROM t WHERE id IS NULL) AS missing_ids, (SELECT COUNT(*) FROM t WHERE flag IS NOT NULL AND flag NOT IN (0,1)) AS invalid_flag_rows",
).length, 0);
assert.equal(sqlContractIssues(
  "Count missing identifiers and invalid domains separately.",
  "SELECT COUNT(*) FILTER (WHERE id IS NULL) AS missing_ids, COUNT(*) FILTER (WHERE flag IS NOT NULL AND flag NOT IN (0,1)) AS invalid_flag_rows FROM t",
).length, 0);
assert.equal(sqlContractIssues(
  "Group rows by age band.",
  "SELECT CASE WHEN age < 30 THEN 'young' ELSE 'older' END AS age_band, COUNT(*) n FROM people GROUP BY age_band",
).length, 1);
assert.equal(sqlContractIssues("Count rows with a sentinel in audited fields.", "SELECT COUNT(*) FILTER (WHERE a=-1 AND b=-1 AND c=-1) AS sentinel_rows FROM t").length, 1);
assert.equal(sqlContractIssues("Return violating_codes.", "SELECT STRING_AGG(code, ',') AS violating_codes FROM t").length, 1);
assert.equal(sqlContractIssues("Return a list of violating codes.", "SELECT LIST(code) AS violating_codes FROM t").length, 0);
assert.equal(sqlContractIssues(
  "Calculate the three-month average of monthly recorded value.",
  "WITH m AS (SELECT month, AVG(value) v FROM t GROUP BY month) SELECT AVG(v) FROM m",
).length, 1);
assert.equal(sqlContractIssues(
  "Calculate the average of monthly average temperature.",
  "WITH m AS (SELECT month, AVG(value) v FROM t GROUP BY month) SELECT AVG(v) FROM m",
).length, 0);
assert.equal(sqlContractIssues(
  "Calculate the three-month average of monthly recorded value.",
  "SELECT AVG(value) FROM t",
).length, 1);
assert.deepEqual(
  explicitResultContract(
    "Return mapping, codes_with_multiple_names, names_with_multiple_codes for exactly 11 mappings.",
  ),
  {
    requiredColumns: ["mapping", "codes_with_multiple_names", "names_with_multiple_codes"],
    expectedRowCount: 11,
  },
);
assert.deepEqual(
  explicitResultContract("Trả về customer_count; không hiển thị customer_id hay postal_code."),
  { requiredColumns: ["customer_count"] },
);
assert.equal(
  explicitResultContract("Produce a long-form 11 mapping code-name audit.").expectedRowCount,
  11,
);
assert.deepEqual(
  explicitResultContract("Return month and recorded_price_sum."),
  { requiredColumns: ["recorded_price_sum"] },
);
assert.deepEqual(
  explicitResultContract("Do not return IDs. Return age_band, customer_count."),
  { requiredColumns: ["age_band", "customer_count"] },
);
assert.deepEqual(
  explicitResultContract("Không trả về article_id. Trả về top_10_transaction_rows và top_10_share_pct."),
  { requiredColumns: ["top_10_transaction_rows", "top_10_share_pct"] },
);

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

const contractCorrections: SqlCorrection[] = [];
const contractResult = await generateAndRunQuery(
  "Return mapping, codes_with_multiple_names, names_with_multiple_codes for exactly 11 mappings; for example mapping alpha.",
  async (_question, correction) => {
    if (correction) {
      contractCorrections.push(correction);
      return "SELECT mapping, codes_with_multiple_names, names_with_multiple_codes FROM fixed";
    }
    return {
      intent: "query",
      brief: {
        ...qualityBrief,
        grain: "one row per mapping",
        dimensions: ["mapping_label"],
        outputColumns: ["mapping_label"],
      },
      sql: "SELECT mapping_label FROM broken",
    };
  },
  (sql) => sql.includes("broken")
    ? {
        sql,
        columns: ["mapping_label", "codes_with_multiple_names", "names_with_multiple_codes"],
        rows: Array.from({ length: 11 }, (_, index) => ({
          mapping_label: `m${index}`,
          codes_with_multiple_names: ["code"],
          names_with_multiple_codes: ["name"],
        })),
        truncated: false,
      }
    : {
        sql,
        columns: ["mapping", "codes_with_multiple_names", "names_with_multiple_codes"],
        rows: Array.from({ length: 11 }, (_, index) => ({
          mapping: `m${index}`,
          codes_with_multiple_names: 0,
          names_with_multiple_codes: 0,
        })),
        truncated: false,
      },
);
assert.equal(contractResult.intent, "query");
assert.match(contractCorrections[0].error, /missing explicitly requested columns: mapping/);
assert.match(contractCorrections[0].error, /Array aggregates were not requested/);
assert.deepEqual(contractCorrections[0].brief?.outputColumns, [
  "mapping",
  "codes_with_multiple_names",
  "names_with_multiple_codes",
]);

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
