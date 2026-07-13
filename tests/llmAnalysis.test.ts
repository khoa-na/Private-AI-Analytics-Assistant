import assert from "node:assert/strict";
import {
  deterministicAnalysis,
  evidenceFromRows,
  parseAnalysis,
  parseAnalysisWithOneRetry,
} from "../lib/llmAnalysis";
import { profileResult } from "../lib/resultProfile";

const rows = [{ month: "2024-01", revenue: 10 }];
const valid = JSON.stringify({
  analysis: {
    summary: "Revenue was 10.",
    summaryEvidence: ["revenue = 10"],
    insights: [{ statement: "Revenue was 10.", evidence: ["revenue = 10"] }],
    caveats: [],
  },
  chart: {
    type: "line",
    reason: "Monthly data is a time series.",
    xKey: "month",
    yKeys: ["revenue"],
  },
  followUpQuestions: [],
});

assert.equal(
  parseAnalysis(
    valid,
    ["month", "revenue"],
    evidenceFromRows(rows),
    ["revenue"],
  ).chart.type,
  "line",
);
const unsupportedInsight = JSON.parse(valid);
unsupportedInsight.analysis.insights[0].evidence = ["revenue = 99"];
assert.throws(
  () =>
    parseAnalysis(
      JSON.stringify(unsupportedInsight),
      ["month", "revenue"],
      evidenceFromRows(rows),
    ),
  /supported evidence/,
);
const invalidChart = JSON.parse(valid);
invalidChart.chart.yKeys = ["month"];
const salvaged = parseAnalysis(
  JSON.stringify(invalidChart),
  ["month", "revenue"],
  evidenceFromRows(rows),
  ["revenue"],
);
assert.equal(salvaged.chart.type, "none");
assert.equal(salvaged.analysis.summary, "Revenue was 10.");
let attempts = 0;
assert.equal(
  (
    await parseAnalysisWithOneRetry(
      async () => (++attempts === 1 ? "not json" : valid),
      ["month", "revenue"],
      evidenceFromRows(rows),
      ["revenue"],
    )
  ).chart.type,
  "line",
);
assert.equal(attempts, 2);

const fallback = await parseAnalysisWithOneRetry(
  async () => "not json",
  ["month", "revenue"],
  evidenceFromRows(rows),
  ["revenue"],
);
assert.equal(fallback.chart.type, "none");
assert.equal(fallback.analysis.insights.length, 0);

const scalar = deterministicAnalysis(
  "Tổng doanh thu là bao nhiêu?",
  "SELECT SUM(price) AS revenue FROM items LIMIT 1000",
  profileResult([{ revenue: 10 }]),
);
assert.equal(scalar?.chart.type, "none");
assert.deepEqual(scalar?.analysis.summaryEvidence, ["revenue = 10"]);

const ranking = deterministicAnalysis(
  "Top 2 products",
  "SELECT product_id, revenue FROM products ORDER BY revenue DESC LIMIT 2",
  profileResult([
    { product_id: "p1", revenue: 20 },
    { product_id: "p2", revenue: 10 },
  ]),
);
assert.equal(ranking?.chart.type, "bar");
assert.equal(ranking?.chart.xKey, "product_id");

const timeSeries = deterministicAnalysis(
  "Revenue by month",
  "SELECT purchase_month, revenue FROM sales LIMIT 1000",
  profileResult([
    { purchase_month: "2024-01", revenue: 10 },
    { purchase_month: "2024-02", revenue: 20 },
  ]),
);
assert.equal(timeSeries?.chart.type, "line");
assert.equal(timeSeries?.chart.xKey, "purchase_month");

console.log("llmAnalysis tests passed");
