import assert from "node:assert/strict";
import { evidenceFromRows, parseAnalysis } from "../lib/llmAnalysis";

const rows = [{ month: "2024-01", revenue: 10 }];
const valid = JSON.stringify({
  analysis: {
    summary: "Revenue was 10.",
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
assert.throws(
  () =>
    parseAnalysis(
      valid.replace("revenue = 10", "revenue = 99"),
      ["month", "revenue"],
      evidenceFromRows(rows),
    ),
  /supported evidence/,
);
const invalidChart = JSON.parse(valid);
invalidChart.chart.yKeys = ["month"];
assert.throws(
  () =>
    parseAnalysis(
      JSON.stringify(invalidChart),
      ["month", "revenue"],
      evidenceFromRows(rows),
      ["revenue"],
    ),
  /chart specification/,
);

console.log("llmAnalysis tests passed");
