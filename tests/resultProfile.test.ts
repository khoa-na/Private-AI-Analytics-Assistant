import assert from "node:assert/strict";
import { assessResultQuality, profileResult } from "../lib/resultProfile";

const profile = profileResult(
  [
    { month: "2024-01", revenue: 10, note: null },
    { month: "2024-02", revenue: 20, note: null },
  ],
  1,
  true,
);

assert.equal(profile.rowCount, 2);
assert.equal(profile.sampleRows.length, 1);
assert.equal(profile.truncated, true);
assert.deepEqual(profile.columns[1], {
  name: "revenue",
  type: "number",
  nullCount: 0,
  min: 10,
  max: 20,
  average: 15,
});
assert.equal(profile.columns[2].type, "null");

assert.deepEqual(
  profileResult([0, 99, 2, 3, 4].map((value) => ({ value })), 3).sampleRows,
  [{ value: 0 }, { value: 99 }, { value: 4 }],
);

assert.deepEqual(
  profileResult([{ first_metric: 1 }, { second_metric: 2 }]).columns.map(({ name, nullCount }) => ({ name, nullCount })),
  [{ name: "first_metric", nullCount: 0 }, { name: "second_metric", nullCount: 0 }],
);
assert.equal(profileResult([{ metric: null }, { other: 1 }]).columns[0].nullCount, 1);

const brief = {
  objective: "Revenue by month",
  metric: "revenue",
  grain: "one row per month",
  dimensions: ["month"],
  outputColumns: ["month", "revenue"],
  filters: [],
};
assert.deepEqual(
  assessResultQuality(
    ["month", "revenue"],
    [{ month: "2024-01", revenue: 10 }, { month: "2024-01", revenue: 20 }],
    false,
    brief,
  ).issues,
  ["Result contains duplicate rows at the declared grain: month."],
);
assert.deepEqual(
  assessResultQuality(["month"], [{ month: "2024-01" }], true, brief),
  {
    issues: ["Result is missing required output columns: revenue."],
    caveats: ["The query result was truncated by the row limit."],
  },
);
assert.deepEqual(
  assessResultQuality(
    ["correct_average", "naive_average", "absolute_gap"],
    [{ correct_average: 10, naive_average: 8, absolute_gap: 4 }],
    false,
    {
      ...brief,
      grain: "one scalar row",
      dimensions: [],
      outputColumns: ["correct_average", "naive_average", "absolute_gap"],
    },
  ).issues,
  ["absolute_gap must equal the absolute difference between correct_average and naive_average."],
);
assert.deepEqual(
  assessResultQuality(
    ["mapping"],
    [{ mapping: "a" }, { mapping: "b" }],
    false,
    { ...brief, grain: "one row per mapping; exactly 3 rows", dimensions: ["mapping"], outputColumns: ["mapping"] },
  ).issues,
  ["Brief requires exactly 3 rows; SQL returned 2."],
);
assert.deepEqual(
  assessResultQuality(
    ["weekday", "weekday_days", "avg_transaction_rows"],
    [{ weekday: "0", weekday_days: "Sunday", avg_transaction_rows: 10 }],
    false,
    {
      ...brief,
      dimensions: ["weekday"],
      outputColumns: ["weekday", "weekday_days", "avg_transaction_rows"],
    },
  ).issues,
  ["weekday_days must be a non-negative numeric metric."],
);

console.log("resultProfile tests passed");
