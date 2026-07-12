import assert from "node:assert/strict";
import { runMultiQueryPlan } from "../lib/multiQuery";

const questions: string[] = [];
const output = await runMultiQueryPlan(
  "Compare delivery and reviews",
  {
    intent: "multi_query",
    steps: [
      { kind: "query", purpose: "Delivery", question: "Late rate by state", requiredGrain: "state", filters: [] },
      { kind: "query", purpose: "Reviews", question: "Review score by state", requiredGrain: "state", filters: [] },
    ],
  },
  async (question) => {
    questions.push(question);
    const delivery = question.startsWith("Late");
    return {
      intent: "query" as const,
      result: {
        sql: delivery ? "SELECT late_rate" : "SELECT review_score",
        columns: [delivery ? "late_rate" : "review_score"],
        rows: [{ [delivery ? "late_rate" : "review_score"]: delivery ? 12 : 3.8 }],
        truncated: false,
      },
      sqlGenerationMs: 1,
      queryMs: 2,
    };
  },
  async (_question, sql, profile, useDeterministic) => {
    assert.match(sql, /Delivery/);
    assert.equal(useDeterministic, false);
    assert.deepEqual(profile.sampleRows[0], {
      "step_1.row_1.late_rate": 12,
      "step_2.row_1.review_score": 3.8,
    });
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
  "Late rate by state\nRequired result grain: state.\nRequired filters: none.",
  "Review score by state\nRequired result grain: state.\nRequired filters: none.",
]);
assert.equal(output.steps.length, 2);
assert.equal(output.timings.sqlGenerationMs, 2);
assert.equal(output.timings.queryMs, 4);

console.log("multiQuery tests passed");
