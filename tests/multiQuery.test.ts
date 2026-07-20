import assert from "node:assert/strict";
import { applyParentResultContract, runMultiQueryPlan, sourceTablesFromSql } from "../lib/multiQuery";

const brief = {
  objective: "Compare delivery and reviews",
  metric: "rate or score",
  grain: "one scalar row per step",
  dimensions: [],
  outputColumns: ["value"],
  filters: [],
};

const contractedSteps = applyParentResultContract(
  "Run a long-form 11 mapping audit with mapping, codes_with_multiple_names, names_with_multiple_codes.",
  [
    {
      kind: "query",
      purpose: "Audit code-name mappings",
      question: "Show every mapping label and multiplicity count",
      brief: {
        ...brief,
        outputColumns: ["mapping_label", "codes_with_multiple_names", "names_with_multiple_codes"],
      },
      sql: "SELECT mapping_label",
    },
    {
      kind: "query",
      purpose: "Audit invalid ages",
      question: "Count invalid ages",
      brief: { ...brief, outputColumns: ["invalid_age_rows"] },
      sql: "SELECT invalid_age_rows",
    },
  ],
);
assert.deepEqual(contractedSteps[0].brief?.outputColumns, [
  "mapping",
  "codes_with_multiple_names",
  "names_with_multiple_codes",
]);
assert.deepEqual(contractedSteps[1].brief?.outputColumns, ["invalid_age_rows"]);
assert.match(contractedSteps[0].brief?.grain ?? "", /exactly 11 rows/);
assert.doesNotMatch(contractedSteps[1].brief?.grain ?? "", /exactly 11 rows/);
const transactionSteps = applyParentResultContract(
  "Return separate views ranked by transaction rows.",
  [{
    kind: "query",
    purpose: "Products by transaction count",
    question: "Rank products by transaction count",
    brief: { ...brief, outputColumns: ["product", "product_count"] },
    sql: "SELECT product, COUNT(*) AS product_count FROM transactions GROUP BY product",
  }],
);
assert.deepEqual(transactionSteps[0].brief?.outputColumns, ["product", "transaction_rows"]);
assert.match(transactionSteps[0].sql, /AS transaction_rows/);
assert.deepEqual(
  sourceTablesFromSql("WITH daily AS (SELECT * FROM transactions) SELECT * FROM daily JOIN articles a ON true"),
  ["transactions", "articles"],
);

const questions: string[] = [];
const output = await runMultiQueryPlan(
  "Compare delivery and reviews",
  {
    intent: "multi_query",
    brief,
    steps: [
      { kind: "query", purpose: "Delivery", question: "Late rate by state", brief: { ...brief, outputColumns: ["late_rate"] }, sql: "SELECT late_rate" },
      { kind: "query", purpose: "Reviews", question: "Review score by state", brief: { ...brief, outputColumns: ["review_score"] }, sql: "SELECT review_score" },
    ],
  },
  async (step) => {
    questions.push(step.question);
    const delivery = step.question.startsWith("Late");
    return {
      intent: "query" as const,
      result: {
        sql: delivery ? "SELECT late_rate" : "SELECT review_score",
        columns: [delivery ? "late_rate" : "review_score"],
        rows: [{ [delivery ? "late_rate" : "review_score"]: delivery ? 12 : 3.8 }],
        truncated: false,
      },
      brief: step.brief,
      quality: { issues: [], caveats: [] },
      sqlGenerationMs: 1,
      queryMs: 2,
    };
  },
  async (_question, sql, profile, useDeterministic) => {
    assert.match(sql, /Delivery/);
    assert.equal(useDeterministic, false);
    assert.deepEqual(profile.sampleRows, [
      { analysis_step: "1: Delivery", row_number: 1, late_rate: 12 },
      { analysis_step: "2: Reviews", row_number: 1, review_score: 3.8 },
    ]);
    assert.deepEqual(
      profile.columns.filter(({ name }) => ["late_rate", "review_score"].includes(name))
        .map(({ name, nullCount }) => ({ name, nullCount })),
      [{ name: "late_rate", nullCount: 0 }, { name: "review_score", nullCount: 0 }],
    );
    return {
      analysis: {
        summary: "Compared.",
        summaryEvidence: ["step_1.row_1.late_rate = 12"],
        insights: [],
        caveats: [],
      },
      chart: { type: "none" as const, reason: "Comparison only." },
      followUpQuestions: [],
    };
  },
);

assert.deepEqual(questions, [
  "Late rate by state",
  "Review score by state",
]);
assert.equal(output.steps.length, 2);
assert.deepEqual(output.steps[0].sourceTables, []);
assert.equal(output.timings.sqlGenerationMs, 2);
assert.equal(output.timings.queryMs, 4);

console.log("multiQuery tests passed");
