import assert from "node:assert/strict";
import { profileResult } from "../lib/resultProfile";
import {
  evaluateComparisons,
  evaluateExpectedFacts,
  evaluateSummary,
  hasExpectedFacts,
} from "../lib/summaryEvaluation";

const profile = profileResult([{ customer_state: "SP", delivery_days: 8.1123 }]);
assert.equal(
  hasExpectedFacts([{ renamed_metric: 13591643.7 }], ["merchandise_sales = 13591643\\.7"]),
  true,
);
assert.equal(
  evaluateExpectedFacts([{ any_alias: 8.1123 }], [{ value: 8.11, tolerance: 0.01 }]),
  true,
);
assert.equal(
  evaluateSummary(
    "SP averaged 8.11 delivery days.",
    ["customer_state = SP", "delivery_days = 8.1123"],
    [],
    profile,
  ).numbersGrounded,
  true,
);

const ratioProfile = profileResult([{ late_rate: 0.122, payment_value: 12_542_084.19 }]);
assert.equal(
  evaluateSummary("Late rate was 12.2%.", ["late_rate = 0.122"], [], ratioProfile)
    .numbersGrounded,
  true,
);
assert.equal(
  evaluateSummary(
    "Payment value was 12.54 million.",
    ["payment_value = 12542084.19"],
    [],
    ratioProfile,
  ).numbersGrounded,
  true,
);

const ranked = [
  { state: "SP", order_count: 100 },
  { state: "RJ", order_count: 50 },
  { state: "MG", order_count: 25 },
];
const categories = [
  { category: "a", product_count: 3029 },
  { category: "b", product_count: 50 },
  { category: "c", product_count: 25 },
];
assert.equal(
  evaluateSummary(
    "Several categories have fewer than 100 products.",
    ["category = a", "product_count = 3029"],
    [],
    profileResult(categories),
    [],
    [],
    categories,
  ).numbersGrounded,
  true,
);
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
