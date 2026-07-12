import assert from "node:assert/strict";
import { compileQueryPlan, parsePlannedIntent } from "../lib/queryPlan";

assert.equal(
  compileQueryPlan({
    intent: "query",
    metric: "merchandise_sales",
    dimensions: [],
  }),
  "SELECT SUM(CAST(oi.price AS REAL)) AS merchandise_sales\nFROM order_items oi",
);

const monthlyComparison = compileQueryPlan({
  intent: "query",
  metric: "merchandise_sales",
  dimensions: ["purchase_year", "purchase_month"],
  years: [2017, 2018],
});
assert.match(monthlyComparison, /order_purchase_timestamp/);
assert.match(monthlyComparison, /IN \('2017', '2018'\)/);
assert.match(monthlyComparison, /GROUP BY 1, 2/);
assert.doesNotMatch(monthlyComparison, /shipping_limit_date|AS REAL\).*timestamp/);

const deliveredAverage = compileQueryPlan({
  intent: "query",
  metric: "average_delivered_order_revenue",
  dimensions: [],
});
assert.match(deliveredAverage, /AVG\(order_revenue\)/);
assert.match(deliveredAverage, /SUM\(CAST\(oi\.price AS REAL\)\)/);
assert.doesNotMatch(deliveredAverage, /freight_value/);
assert.doesNotMatch(deliveredAverage, /purchase_month|ORDER BY|LIMIT/);
assert.throws(
  () =>
    compileQueryPlan({
      intent: "query",
      metric: "average_delivered_order_revenue",
      dimensions: ["purchase_month"],
    }),
  /does not support dimensions/,
);
assert.throws(
  () =>
    compileQueryPlan({
      intent: "query",
      metric: "payment_value",
      dimensions: ["customer_state"],
    }),
  /does not support dimensions/,
);
assert.throws(
  () =>
    compileQueryPlan({
      intent: "query",
      metric: "late_order_count",
      dimensions: [],
      reviewScore: 5,
    }),
  /does not support parameter/,
);

assert.match(
  compileQueryPlan({
    intent: "query",
    metric: "multi_payment_method_order_count",
    dimensions: [],
  }),
  /COUNT\(DISTINCT op\.payment_type\) > 1/,
);

const productsByCategory = compileQueryPlan({
  intent: "query",
  metric: "distinct_product_count",
  dimensions: ["product_category"],
  sort: "desc",
  limit: 10,
});
assert.doesNotMatch(productsByCategory, /LIMIT 10|ORDER BY product_count/);

const reviewByPayment = compileQueryPlan({
  intent: "query",
  metric: "average_review_by_payment_type",
  dimensions: ["payment_type"],
});
assert.match(reviewByPayment, /SELECT DISTINCT op\.order_id, op\.payment_type/);
assert.match(reviewByPayment, /GROUP BY r\.order_id/);

assert.match(
  compileQueryPlan({
    intent: "query",
    metric: "distinct_seller_count",
    dimensions: ["seller_state"],
  }),
  /SELECT s\.seller_state.*GROUP BY s\.seller_state/s,
);

assert.deepEqual(parsePlannedIntent('{"intent":"fallback"}'), {
  intent: "fallback",
});
assert.deepEqual(
  parsePlannedIntent(
    '{"intent":"query","metric":"merchandise_sales","dimensions":[],"years":[],"threshold":null,"sort":null,"limit":null,"message":null}',
  ),
  { intent: "query", metric: "merchandise_sales", dimensions: [] },
);
assert.throws(
  () => parsePlannedIntent('{"intent":"query","metric":"average_price","dimensions":[]}'),
  /invalid query plan/,
);

console.log("queryPlan tests passed");
