import assert from "node:assert/strict";
import { generateSql, getSqlContext, needsSqlReview, parseSqlPlan, parseSqlReview } from "../lib/llmSql";

const context = getSqlContext();
assert.match(context, /Schema:/);
assert.match(context, /Dataset semantics:/);
assert.match(context, /Schema:\n[^\n]+\(/);

const scalarBrief = {
  objective: "Count rows",
  metric: "row count",
  grain: "one scalar row",
  dimensions: [],
  outputColumns: ["row_count"],
  filters: [],
};
assert.deepEqual(
  parseSqlPlan(JSON.stringify({
    intent: "query",
    brief: scalarBrief,
    sql: "SELECT COUNT(*) AS row_count FROM facts",
  }), "Count rows"),
  { intent: "query", brief: scalarBrief, sql: "SELECT COUNT(*) AS row_count FROM facts" },
);
assert.deepEqual(
  parseSqlPlan('{"intent":"clarification","message":"Define revenue."}', "Revenue"),
  { intent: "clarification", message: "Define revenue." },
);
const multi = parseSqlPlan(JSON.stringify({
  intent: "multi_query",
  brief: { ...scalarBrief, objective: "Compare trend and mix", outputColumns: [] },
  steps: [
    {
      purpose: "Monthly trend",
      brief: { ...scalarBrief, grain: "one row per month", dimensions: ["month"], outputColumns: ["month", "n"] },
      sql: "SELECT month, COUNT(*) n FROM facts GROUP BY month",
    },
    {
      purpose: "Category mix",
      question: "Count rows by category",
      brief: { ...scalarBrief, grain: "one row per category", dimensions: ["category"], outputColumns: ["category", "n"] },
      sql: "SELECT category, COUNT(*) n FROM facts GROUP BY category",
    },
  ],
}), "Compare trend and mix");
assert.equal(typeof multi === "object" && multi.intent, "multi_query");
if (multi.intent !== "multi_query") throw new Error("Expected multi-query plan.");
assert.equal(multi.steps.length, 2);
assert.match(multi.steps[0].question, /Monthly trend/);
assert.equal(multi.steps[1].question, "Count rows by category");
assert.throws(
  () => parseSqlPlan('{"intent":"multi_query","steps":[{"purpose":"Only","sql":"SELECT 1"}]}', "One step"),
  /two or three/,
);
assert.equal(needsSqlReview({ intent: "query", brief: scalarBrief, sql: "SELECT COUNT(*) row_count FROM facts" }), false);
assert.equal(needsSqlReview({ intent: "query", brief: scalarBrief, sql: "SELECT a.x FROM a JOIN b ON a.id = b.id" }), true);
assert.equal(needsSqlReview({ intent: "query", brief: scalarBrief, sql: "SELECT good * 1.0 / total AS rate FROM facts" }), true);
assert.equal(needsSqlReview(multi), true);
assert.deepEqual(parseSqlReview('{"approved":true,"issues":[]}'), { approved: true, issues: [] });
assert.throws(() => parseSqlReview('{"approved":false,"issues":[]}'), /requires issues/);

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_MODEL = "test-model";
let requests = 0;
globalThis.fetch = async () => new Response(JSON.stringify(requests++ === 0
  ? {
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          intent: "query",
          brief: scalarBrief,
          sql: "SELECT COUNT(*) AS row_count FROM facts f JOIN dims d ON f.id = d.id",
        }) },
      }],
    }
  : { choices: [{ finish_reason: "length", message: { content: null } }] }));
try {
  const reviewUnavailable = await generateSql("Count joined rows");
  if (typeof reviewUnavailable === "string") throw new Error("Expected structured query plan.");
  assert.equal(reviewUnavailable.intent, "query");
  if (reviewUnavailable.intent !== "query") throw new Error("Expected query plan.");
  assert.equal(reviewUnavailable.review?.decision, "unavailable");
  assert.match(reviewUnavailable.review?.issues[0] ?? "", /token budget/);
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
}

console.log("llmSql tests passed");
