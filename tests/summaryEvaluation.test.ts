import assert from "node:assert/strict";
import { profileResult } from "../lib/resultProfile";
import { evaluateComparisons, evaluateSummary } from "../lib/summaryEvaluation";

const profile = profileResult([{ customer_state: "SP", delivery_days: 8.1123 }]);
assert.equal(
  evaluateSummary(
    "SP averaged 8.11 delivery days.",
    ["customer_state = SP", "delivery_days = 8.1123"],
    [],
    profile,
  ).numbersGrounded,
  true,
);

const ranked = [
  { state: "SP", order_count: 100 },
  { state: "RJ", order_count: 50 },
  { state: "MG", order_count: 25 },
];
assert.equal(evaluateComparisons("SP has the highest order count.", ranked).valid, true);
assert.equal(evaluateComparisons("RJ has the highest order count.", ranked).valid, false);
assert.equal(
  evaluateComparisons("Rio has the highest order count.", ranked, [
    "state = SP",
    "order_count = 100",
  ]).valid,
  true,
);
assert.equal(evaluateComparisons("SP holds the majority of orders.", ranked).valid, true);
assert.equal(
  evaluateComparisons("Order count increased steadily.", ranked).valid,
  false,
);

const invented = evaluateSummary(
  "The overall average was 18.78 days.",
  ["delivery_days = 8.1123"],
  [],
  profile,
);
assert.deepEqual(invented.unsupportedNumbers, ["18.78"]);
assert.equal(invented.numbersGrounded, false);

assert.equal(
  evaluateSummary(
    "Results were limited to 1000 rows.",
    ["customer_state = SP"],
    [],
    profile,
  ).truncationValid,
  false,
);

console.log("summaryEvaluation tests passed");
