import assert from "node:assert/strict";
import { profileResult } from "../lib/resultProfile";
import {
  caseStatus,
  evaluateComparisons,
  evaluateExpectedFacts,
  evaluateSummary,
  hasExpectedFacts,
  intentMatchesExpected,
  matchesTextPatterns,
  matchesSqlRequirement,
} from "../lib/summaryEvaluation";

assert.equal(caseStatus({ corePassed: true }), "PASS_FIRST_TRY");
assert.equal(caseStatus({ corePassed: true, reviewRepaired: true }), "PASS_AFTER_REVIEW_REPAIR");
assert.equal(caseStatus({ corePassed: true, sqlRepaired: true }), "PASS_AFTER_SQL_REPAIR");
assert.equal(caseStatus({ corePassed: true, presentationPassed: false }), "PASS_CORE_FAIL_PRESENTATION");
assert.equal(caseStatus({ corePassed: false, failure: "analysis" }), "FAIL_ANALYSIS");
assert.equal(caseStatus({ corePassed: false, failure: "safety" }), "FAIL_SAFETY");
assert.equal(intentMatchesExpected("clarification", "unsupported"), true);
assert.equal(intentMatchesExpected("unsupported", "refusal"), true);
assert.equal(intentMatchesExpected("clarification", "refusal"), false);
assert.equal(matchesTextPatterns("The dataset does not include orders.", ["missing|unavailable"]), true);
assert.equal(matchesTextPatterns("The metric is not available.", ["unavailable"]), true);
assert.equal(matchesTextPatterns("Please clarify the definition.", ["define|meaning"]), true);

const profile = profileResult([{ customer_state: "SP", delivery_days: 8.1123 }]);
assert.equal(
  hasExpectedFacts([{ renamed_metric: 13591643.7 }], ["merchandise_sales = 13591643\\.7"]),
  true,
);
assert.equal(
  evaluateExpectedFacts([{ any_alias: 8.1123 }], [{ value: 8.11, tolerance: 0.01 }]),
  true,
);
const monthlyFacts = [
  { month: "2020-06", transaction_rows: 100, recorded_price_sum: 20 },
  { month: "2020-07", transaction_rows: 20, recorded_price_sum: 100 },
];
assert.equal(
  evaluateExpectedFacts(monthlyFacts, [{
    column: "recorded_price_sum",
    value: 20,
    where: { month: "2020-06" },
  }]),
  true,
);
assert.equal(
  evaluateExpectedFacts(monthlyFacts, [{
    column: "recorded_price_sum",
    value: 100,
    where: { month: "2020-06" },
  }]),
  false,
);
assert.equal(
  evaluateExpectedFacts(monthlyFacts, [{ column: "transaction_rows", value: 100.1 }]),
  false,
);
assert.equal(
  evaluateExpectedFacts(monthlyFacts, [{ column: "month", value: "2020-06", rowIndex: 0 }]),
  true,
);
assert.equal(
  evaluateExpectedFacts(monthlyFacts, [{ column: "month", value: "2020-06", rowIndex: 1 }]),
  false,
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
assert.equal(
  evaluateSummary(
    "As of 2020-09-22, the segment had 10 customers.",
    ["customer_count = 10"],
    [],
    profileResult([{ customer_count: 10 }]),
    [],
    [],
    undefined,
    "Show customer count as of 2020-09-22.",
  ).numbersGrounded,
  true,
);
assert.equal(
  evaluateSummary(
    "Average catalogue count was about 15.3.",
    ["catalog_articles = 15.318"],
    [],
    profileResult([{ catalog_articles: 15.318 }]),
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
assert.equal(evaluateComparisons(
  "Garment Upper body has the highest percentage.",
  [
    { segment_type: "product", segment_value: "Garment Upper body", pct: 40 },
    { segment_type: "product", segment_value: "Shoes", pct: 10 },
  ],
).valid, true);
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

assert.equal(evaluateExpectedFacts(
  [{ period: "2019 Full Year", rows: 1 }, { period: "2020 (Jan 1 - Sep 22)", rows: 2 }],
  [
    { column: "rows", value: 1, where: { period: "2019" } },
    { column: "rows", value: 2, where: { period: "2020-through-09-22" } },
  ],
), true);
assert.equal(matchesSqlRequirement(
  "SELECT COUNT(*) FROM customers LEFT JOIN (SELECT DISTINCT customer_id FROM transactions) tx ON 1=1",
  "WITH",
), true);

console.log("summaryEvaluation tests passed");
