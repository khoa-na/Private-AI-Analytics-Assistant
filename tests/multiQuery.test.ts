import assert from "node:assert/strict";
import { runMultiQueryPlan } from "../lib/multiQuery";

const brief = {
  objective: "Compare delivery and reviews",
  metric: "rate or score",
  grain: "one scalar row per step",
  dimensions: [],
  outputColumns: ["value"],
  filters: [],
};

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
assert.equal(output.timings.sqlGenerationMs, 2);
assert.equal(output.timings.queryMs, 4);

console.log("multiQuery tests passed");
