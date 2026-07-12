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

console.log("resultProfile tests passed");
