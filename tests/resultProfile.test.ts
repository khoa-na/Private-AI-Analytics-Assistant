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

console.log("resultProfile tests passed");
