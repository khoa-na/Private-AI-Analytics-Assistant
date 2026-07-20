import assert from "node:assert/strict";
import { alignResultColumns, explicitResultContract, generateAndRunQuery, normalizeDerivedMetrics, normalizeMultiplicityCollections, normalizeSqlAliases, pivotNamedScalarMetrics, sqlContractIssues } from "../lib/generatedQuery";
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
assert.equal(sqlContractIssues(
  "Aggregate by article_id first before joining products.",
  "WITH a AS (SELECT article_id, COUNT(*) n FROM facts GROUP BY article_id) SELECT * FROM a JOIN products p USING (article_id)",
).length, 0);
assert.match(sqlContractIssues(
  "Tổng hợp theo t_dat trước, sau đó tính theo tháng.",
  "WITH d AS (SELECT t_dat, value FROM facts) SELECT month, SUM(value) FROM d GROUP BY month",
).join(" "), /Pre-aggregate by t_dat/);
assert.match(sqlContractIssues(
  "Calculate nearest-rank P25.",
  "SELECT value FROM ranked WHERE rn = FLOOR(0.25 * (n + 1))",
).join(" "), /CEIL/);
assert.match(sqlContractIssues(
  "Return codes_with_multiple_names and names_with_multiple_codes.",
  "SELECT COUNT(DISTINCT code) AS codes_with_multiple_names, COUNT(DISTINCT name) AS names_with_multiple_codes FROM mapped WHERE names_per_code > 1 OR codes_per_name > 1",
).join(" "), /contaminates/);
assert.equal(sqlContractIssues(
  "Return codes_with_multiple_names and names_with_multiple_codes.",
  "SELECT COUNT(DISTINCT CASE WHEN names_per_code > 1 THEN code END) AS codes_with_multiple_names, COUNT(DISTINCT CASE WHEN codes_per_name > 1 THEN name END) AS names_with_multiple_codes FROM mapped",
).length, 0);
assert.match(sqlContractIssues(
  "Return codes_with_multiple_names and names_with_multiple_codes.",
  "SELECT SUM(CASE WHEN a.num_names > 1 THEN 1 ELSE 0 END) AS codes_with_multiple_names, SUM(CASE WHEN b.num_codes > 1 THEN 1 ELSE 0 END) AS names_with_multiple_codes FROM mappings m LEFT JOIN code_counts a ON m.mapping=a.mapping LEFT JOIN name_counts b ON m.mapping=b.mapping",
).join(" "), /multiplies rows/);
assert.match(sqlContractIssues(
  "Calculate nearest-rank P25.",
  "SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY value) FROM facts",
).join(" "), /CEIL/);
assert.match(sqlContractIssues(
  "Rank products.",
  "SELECT at.transaction_rows FROM article_totals at",
).join(" "), /non-reserved table alias/);
assert.equal(
  normalizeSqlAliases("SELECT at.n FROM article_totals at JOIN articles a ON at.id = a.id"),
  "SELECT at_alias.n FROM article_totals at_alias JOIN articles a ON at_alias.id = a.id",
);
assert.equal(
  normalizeMultiplicityCollections(
    "Return codes_with_multiple_names and names_with_multiple_codes.",
    "SELECT COALESCE((SELECT LIST(code) FROM counts WHERE n > 1), []) AS codes_with_multiple_names",
  ),
  "SELECT COALESCE((SELECT COUNT(DISTINCT code) FROM counts WHERE n > 1), 0) AS codes_with_multiple_names",
);
assert.deepEqual(
  alignResultColumns({
    sql: "SELECT mapping_label FROM facts",
    columns: ["mapping_label", "n"],
    rows: [{ mapping_label: "code_name", n: 1 }],
    truncated: false,
  }, ["mapping"]).rows,
  [{ mapping: "code_name", n: 1 }],
);
assert.equal(normalizeDerivedMetrics({
  sql: "SELECT ...",
  columns: ["correct_average", "naive_average", "absolute_gap"],
  rows: [{ correct_average: 10, naive_average: 8, absolute_gap: -2 }],
  truncated: false,
}).rows[0].absolute_gap, 2);
assert.deepEqual(
  pivotNamedScalarMetrics({
    sql: "SELECT relationship, orphan_count FROM audit",
    columns: ["relationship", "orphan_count"],
    rows: [
      { relationship: "article", orphan_count: 0 },
      { relationship: "customer", orphan_count: 2 },
    ],
    truncated: false,
  }, ["orphan_article_rows", "orphan_customer_rows"]).rows,
  [{ orphan_article_rows: 0, orphan_customer_rows: 2 }],
);
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
assert.deepEqual(
  explicitResultContract("Return strftime(t_dat, '%w') as weekday, weekday_days, avg_transaction_rows."),
  { requiredColumns: ["weekday", "weekday_days", "avg_transaction_rows"] },
);
assert.deepEqual(
  explicitResultContract("Trả về orphan_article_rows và orphan_customer_rows."),
  {
    requiredColumns: ["orphan_article_rows", "orphan_customer_rows"],
    expectedRowCount: 1,
  },
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

let stagedAttempt = 0;
const crossStageRepaired = await generateAndRunQuery(
  "Return the unrounded value.",
  async () => [
    "SELECT ROUND(value, 2) AS value FROM facts",
    "SELECT broken AS value FROM facts",
    "SELECT value FROM facts",
  ][stagedAttempt++],
  (sql) => {
    if (sql.includes("broken")) throw new Error("no such column: broken");
    return { sql, columns: ["value"], rows: [{ value: 1 }], truncated: false };
  },
);
assert.equal(crossStageRepaired.intent, "query");
if (crossStageRepaired.intent !== "query") throw new Error("Expected query result.");
assert.equal(crossStageRepaired.sqlAttempts?.length, 2);

let shapedCorrection: SqlCorrection | undefined;
await generateAndRunQuery(
  "Return mapping, codes_with_multiple_names, names_with_multiple_codes for exactly 11 mappings.",
  async (_question, correction) => {
    shapedCorrection = correction;
    return correction
      ? "SELECT mapping, codes_with_multiple_names, names_with_multiple_codes FROM fixed"
      : "SELECT STRING_AGG(code, ',') AS codes_with_multiple_names FROM broken";
  },
  (sql) => ({
    sql,
    columns: ["mapping", "codes_with_multiple_names", "names_with_multiple_codes"],
    rows: Array.from({ length: 11 }, (_, index) => ({
      mapping: `m${index}`,
      codes_with_multiple_names: 0,
      names_with_multiple_codes: 0,
    })),
    truncated: false,
  }),
);
assert.equal(shapedCorrection?.brief?.grain, "exactly 11 rows");
assert.deepEqual(shapedCorrection?.brief?.dimensions, ["mapping"]);

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
assert.match(contractCorrections[0].error, /non-negative numeric metric/);
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
