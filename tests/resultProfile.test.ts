import assert from "node:assert/strict";
import { profileResult } from "../lib/resultProfile";

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

console.log("resultProfile tests passed");
