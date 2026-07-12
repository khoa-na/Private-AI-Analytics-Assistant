export const METRICS = [
  "merchandise_sales",
  "average_delivered_order_revenue",
  "units_sold",
  "unsold_product_count",
  "product_sales_range",
  "distinct_product_count",
  "product_average_review",
  "product_average_review_range",
  "product_count_above_average_review",
  "product_count_with_review_score",
  "review_count",
  "late_order_count",
  "late_delivery_rate",
  "average_delivery_days",
  "payment_value",
  "average_order_payment",
  "multi_payment_method_order_count",
  "average_review_by_payment_type",
  "repeat_customer_count",
  "distinct_order_count",
  "customer_merchandise_sales",
  "seller_merchandise_sales",
  "distinct_seller_count",
] as const;

export const DIMENSIONS = [
  "purchase_year",
  "purchase_month",
  "product",
  "product_category",
  "review_score",
  "customer_state",
  "payment_type",
  "customer",
  "seller",
  "seller_state",
] as const;

type Metric = (typeof METRICS)[number];
type Dimension = (typeof DIMENSIONS)[number];

export type QueryPlan = {
  intent: "query";
  metric: Metric;
  dimensions: Dimension[];
  years?: number[];
  threshold?: number;
  minimumCount?: number;
  reviewScore?: number;
  sort?: "asc" | "desc";
  limit?: number;
};

export type PlannedIntent =
  | QueryPlan
  | { intent: "clarification" | "unsupported" | "refusal"; message: string }
  | { intent: "fallback" };

export type IntentResponse = Exclude<PlannedIntent, QueryPlan | { intent: "fallback" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePlannedIntent(output: string): PlannedIntent {
  const json = output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const invalid = () => new Error(`Model returned an invalid query plan: ${json.slice(0, 500)}`);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === null || (key === "years" && Array.isArray(item) && item.length === 0)) {
        delete value[key];
      }
    }
  }
  if (!isRecord(value) || typeof value.intent !== "string") {
    throw invalid();
  }
  if (value.intent === "fallback") return { intent: "fallback" };
  if (["clarification", "unsupported", "refusal"].includes(value.intent)) {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error("Model returned an invalid query plan message.");
    }
    return value as PlannedIntent;
  }
  const validNumber = (key: string) =>
    value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]));
  if (
    value.intent !== "query" ||
    !METRICS.includes(value.metric as Metric) ||
    !Array.isArray(value.dimensions) ||
    !value.dimensions.every((item) => DIMENSIONS.includes(item as Dimension)) ||
    (value.years !== undefined &&
      (!Array.isArray(value.years) || !value.years.every((year) => Number.isInteger(year)))) ||
    !["threshold", "minimumCount", "reviewScore"].every(validNumber) ||
    (value.sort !== undefined && !["asc", "desc"].includes(String(value.sort))) ||
    (value.limit !== undefined &&
      (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 1000))
  ) {
    throw invalid();
  }
  return value as QueryPlan;
}

const COMPATIBILITY: Record<Metric, { dimensions: Dimension[][]; parameters?: string[] }> = {
  merchandise_sales: { dimensions: [[], ["purchase_month"], ["purchase_year", "purchase_month"], ["product"]], parameters: ["years"] },
  average_delivered_order_revenue: { dimensions: [[]] },
  units_sold: { dimensions: [["product_category"]] },
  unsold_product_count: { dimensions: [[]] },
  product_sales_range: { dimensions: [[]] },
  distinct_product_count: { dimensions: [["product_category"]] },
  product_average_review: { dimensions: [["product"], ["product_category"]], parameters: ["minimumCount"] },
  product_average_review_range: { dimensions: [[]] },
  product_count_above_average_review: { dimensions: [[]], parameters: ["threshold"] },
  product_count_with_review_score: { dimensions: [[]], parameters: ["reviewScore"] },
  review_count: { dimensions: [["review_score"]] },
  late_order_count: { dimensions: [[], ["purchase_month"]] },
  late_delivery_rate: { dimensions: [[], ["customer_state"]] },
  average_delivery_days: { dimensions: [["customer_state"]] },
  payment_value: { dimensions: [["payment_type"]] },
  average_order_payment: { dimensions: [[]] },
  multi_payment_method_order_count: { dimensions: [[]] },
  average_review_by_payment_type: { dimensions: [["payment_type"]] },
  repeat_customer_count: { dimensions: [[]], parameters: ["minimumCount"] },
  distinct_order_count: { dimensions: [["customer_state"]] },
  customer_merchandise_sales: { dimensions: [["customer"]] },
  seller_merchandise_sales: { dimensions: [["seller"]] },
  distinct_seller_count: { dimensions: [["seller_state"]] },
};

export function validateQueryPlan(plan: QueryPlan) {
  const rule = COMPATIBILITY[plan.metric];
  const dimensions = [...new Set(plan.dimensions)];
  const matches = rule.dimensions.some(
    (allowed) =>
      allowed.length === dimensions.length && allowed.every((item) => dimensions.includes(item)),
  );
  if (!matches) {
    throw new Error(`${plan.metric} does not support dimensions: ${dimensions.join(", ") || "none"}.`);
  }

  const parameters = ["years", "threshold", "minimumCount", "reviewScore"] as const;
  for (const parameter of parameters) {
    if (plan[parameter] !== undefined && !rule.parameters?.includes(parameter)) {
      throw new Error(`${plan.metric} does not support parameter: ${parameter}.`);
    }
  }
  if (plan.minimumCount !== undefined && (!Number.isInteger(plan.minimumCount) || plan.minimumCount < 1)) {
    throw new Error("minimumCount must be a positive integer.");
  }
  if (plan.reviewScore !== undefined && (plan.reviewScore < 1 || plan.reviewScore > 5)) {
    throw new Error("reviewScore must be between 1 and 5.");
  }
  return plan;
}

const order = (plan: QueryPlan, alias: string) => [
  ...(plan.sort ? [`ORDER BY ${alias} ${plan.sort.toUpperCase()}`] : []),
  ...(plan.limit ? [`LIMIT ${plan.limit}`] : []),
];

const categoryJoins = [
  "JOIN products p ON p.product_id = oi.product_id",
  "LEFT JOIN category_translation ct ON ct.product_category_name = p.product_category_name",
];

export function compileQueryPlan(plan: QueryPlan) {
  validateQueryPlan(plan);
  if (plan.metric === "average_delivered_order_revenue") {
    return [
      "SELECT AVG(order_revenue) AS average_revenue",
      "FROM (",
      "  SELECT SUM(CAST(oi.price AS REAL)) AS order_revenue",
      "  FROM orders o",
      "  JOIN order_items oi ON o.order_id = oi.order_id",
      "  WHERE o.order_status = 'delivered'",
      "  GROUP BY o.order_id",
      ") AS delivered_orders",
    ].join("\n");
  }

  if (plan.metric === "merchandise_sales") {
    const time = plan.dimensions.filter((d) => d === "purchase_year" || d === "purchase_month");
    const entity = plan.dimensions.find((d) => d === "product" || d === "product_category");
    if (entity === "product") {
      return [
        "SELECT oi.product_id, SUM(CAST(oi.price AS REAL)) AS merchandise_sales, COUNT(*) AS units_sold",
        "FROM order_items oi",
        "JOIN products p ON p.product_id = oi.product_id",
        "GROUP BY oi.product_id",
        ...order(plan, "merchandise_sales"),
      ].join("\n");
    }
    const needsOrders = time.length > 0 || Boolean(plan.years?.length);
    const fields = time.map((dimension) =>
      dimension === "purchase_year"
        ? "strftime('%Y', o.order_purchase_timestamp) AS purchase_year"
        : `strftime('${time.includes("purchase_year") ? "%m" : "%Y-%m"}', o.order_purchase_timestamp) AS purchase_month`,
    );
    return [
      `SELECT ${[...fields, "SUM(CAST(oi.price AS REAL)) AS merchandise_sales"].join(", ")}`,
      "FROM order_items oi",
      ...(needsOrders ? ["JOIN orders o ON o.order_id = oi.order_id"] : []),
      ...(plan.years?.length
        ? [`WHERE strftime('%Y', o.order_purchase_timestamp) IN (${plan.years.map((year) => `'${year}'`).join(", ")})`]
        : []),
      ...(fields.length ? [`GROUP BY ${fields.map((_, index) => index + 1).join(", ")}`] : []),
      ...(fields.length ? order(plan, "merchandise_sales") : []),
    ].join("\n");
  }

  if (plan.metric === "units_sold") {
    return [
      "SELECT COALESCE(ct.product_category_name_english, p.product_category_name) AS product_category, COUNT(*) AS units_sold",
      "FROM order_items oi",
      ...categoryJoins,
      "GROUP BY 1",
      ...order(plan, "units_sold"),
    ].join("\n");
  }

  if (plan.metric === "unsold_product_count") {
    return "SELECT COUNT(*) AS product_count\nFROM products p\nLEFT JOIN order_items oi ON oi.product_id = p.product_id\nWHERE oi.product_id IS NULL";
  }

  if (plan.metric === "product_sales_range") {
    return "SELECT MIN(product_sales) AS min_sales, MAX(product_sales) AS max_sales\nFROM (\n  SELECT oi.product_id, SUM(CAST(oi.price AS REAL)) AS product_sales\n  FROM order_items oi\n  GROUP BY oi.product_id\n) AS product_sales";
  }

  if (plan.metric === "distinct_product_count") {
    return [
      "SELECT COALESCE(ct.product_category_name_english, p.product_category_name) AS product_category, COUNT(DISTINCT p.product_id) AS product_count",
      "FROM products p",
      "LEFT JOIN category_translation ct ON ct.product_category_name = p.product_category_name",
      "GROUP BY 1",
      "ORDER BY 1",
    ].join("\n");
  }

  if (plan.metric === "product_count_above_average_review") {
    return `SELECT COUNT(*) AS product_count\nFROM (\n  SELECT oi.product_id\n  FROM order_items oi\n  JOIN order_reviews r ON r.order_id = oi.order_id\n  GROUP BY oi.product_id\n  HAVING AVG(CAST(r.review_score AS REAL)) > ${plan.threshold ?? 0}\n) AS products`;
  }

  if (plan.metric === "product_average_review_range") {
    return "SELECT MIN(avg_review_score) AS min_score, MAX(avg_review_score) AS max_score\nFROM (\n  SELECT oi.product_id, AVG(CAST(r.review_score AS REAL)) AS avg_review_score\n  FROM order_items oi\n  JOIN order_reviews r ON r.order_id = oi.order_id\n  GROUP BY oi.product_id\n) AS product_reviews";
  }

  if (plan.metric === "product_average_review") {
    const category = plan.dimensions.includes("product_category");
    return [
      `SELECT ${category ? "COALESCE(ct.product_category_name_english, p.product_category_name) AS product_category" : "oi.product_id"}, AVG(CAST(r.review_score AS REAL)) AS average_review_score, COUNT(DISTINCT r.order_id) AS reviewed_orders`,
      "FROM order_items oi",
      "JOIN order_reviews r ON r.order_id = oi.order_id",
      ...(category ? categoryJoins : []),
      "GROUP BY 1",
      ...(plan.minimumCount ? [`HAVING COUNT(DISTINCT r.order_id) >= ${plan.minimumCount}`] : []),
      ...order(plan, "average_review_score"),
    ].join("\n");
  }

  if (plan.metric === "product_count_with_review_score") {
    return `SELECT COUNT(DISTINCT oi.product_id) AS product_count\nFROM order_items oi\nJOIN order_reviews r ON r.order_id = oi.order_id\nWHERE CAST(r.review_score AS REAL) = ${plan.reviewScore ?? 5}`;
  }

  if (plan.metric === "review_count") {
    return "SELECT CAST(r.review_score AS REAL) AS review_score, COUNT(*) AS review_count\nFROM order_reviews r\nGROUP BY 1\nORDER BY 1";
  }

  if (plan.metric === "late_order_count") {
    const monthly = plan.dimensions.includes("purchase_month");
    return [
      `SELECT ${monthly ? "strftime('%Y-%m', o.order_purchase_timestamp) AS purchase_month, " : ""}COUNT(*) AS late_order_count`,
      "FROM orders o",
      "WHERE o.order_delivered_customer_date != ''",
      "  AND o.order_estimated_delivery_date != ''",
      "  AND o.order_delivered_customer_date > o.order_estimated_delivery_date",
      ...(monthly ? ["GROUP BY 1", "ORDER BY 1"] : []),
    ].join("\n");
  }

  if (plan.metric === "late_delivery_rate") {
    const byState = plan.dimensions.includes("customer_state");
    return [
      `SELECT ${byState ? "c.customer_state, " : ""}100.0 * SUM(CASE WHEN o.order_delivered_customer_date > o.order_estimated_delivery_date THEN 1 ELSE 0 END) / COUNT(*) AS late_delivery_rate`,
      "FROM orders o",
      ...(byState ? ["JOIN customers c ON c.customer_id = o.customer_id"] : []),
      "WHERE o.order_status = 'delivered'",
      "  AND o.order_delivered_customer_date != ''",
      "  AND o.order_estimated_delivery_date != ''",
      ...(byState ? ["GROUP BY c.customer_state", ...order(plan, "late_delivery_rate")] : []),
    ].join("\n");
  }

  if (plan.metric === "average_delivery_days") {
    return "SELECT c.customer_state, AVG(julianday(o.order_delivered_customer_date) - julianday(o.order_purchase_timestamp)) AS average_delivery_days\nFROM orders o\nJOIN customers c ON c.customer_id = o.customer_id\nWHERE o.order_delivered_customer_date != '' AND o.order_purchase_timestamp != ''\nGROUP BY c.customer_state\nORDER BY c.customer_state";
  }

  if (plan.metric === "payment_value") {
    return [
      "SELECT op.payment_type, SUM(CAST(op.payment_value AS REAL)) AS payment_value",
      "FROM order_payments op",
      "GROUP BY op.payment_type",
      ...order(plan, "payment_value"),
    ].join("\n");
  }

  if (plan.metric === "average_order_payment") {
    return "SELECT AVG(order_payment) AS average_order_payment\nFROM (\n  SELECT op.order_id, SUM(CAST(op.payment_value AS REAL)) AS order_payment\n  FROM order_payments op\n  GROUP BY op.order_id\n) AS payments";
  }

  if (plan.metric === "multi_payment_method_order_count") {
    return "SELECT COUNT(*) AS order_count\nFROM (\n  SELECT op.order_id\n  FROM order_payments op\n  GROUP BY op.order_id\n  HAVING COUNT(DISTINCT op.payment_type) > 1\n) AS orders";
  }

  if (plan.metric === "average_review_by_payment_type") {
    return "WITH payment_types AS (\n  SELECT DISTINCT op.order_id, op.payment_type\n  FROM order_payments op\n), order_reviews_agg AS (\n  SELECT r.order_id, AVG(CAST(r.review_score AS REAL)) AS review_score\n  FROM order_reviews r\n  GROUP BY r.order_id\n)\nSELECT pt.payment_type, AVG(ra.review_score) AS average_review_score\nFROM orders o\nJOIN payment_types pt ON pt.order_id = o.order_id\nJOIN order_reviews_agg ra ON ra.order_id = o.order_id\nGROUP BY pt.payment_type\nORDER BY pt.payment_type";
  }

  if (plan.metric === "repeat_customer_count") {
    return `SELECT COUNT(*) AS customer_count\nFROM (\n  SELECT c.customer_unique_id\n  FROM customers c\n  JOIN orders o ON o.customer_id = c.customer_id\n  GROUP BY c.customer_unique_id\n  HAVING COUNT(DISTINCT o.order_id) > ${plan.minimumCount ?? 1}\n) AS customers`;
  }

  if (plan.metric === "distinct_order_count") {
    return [
      "SELECT c.customer_state, COUNT(DISTINCT o.order_id) AS order_count",
      "FROM customers c",
      "JOIN orders o ON o.customer_id = c.customer_id",
      "GROUP BY c.customer_state",
      ...order(plan, "order_count"),
    ].join("\n");
  }

  if (plan.metric === "customer_merchandise_sales") {
    return [
      "SELECT c.customer_unique_id, SUM(CAST(oi.price AS REAL)) AS merchandise_sales, COUNT(DISTINCT o.order_id) AS order_count",
      "FROM customers c",
      "JOIN orders o ON o.customer_id = c.customer_id",
      "JOIN order_items oi ON oi.order_id = o.order_id",
      "GROUP BY c.customer_unique_id",
      ...order(plan, "merchandise_sales"),
    ].join("\n");
  }

  if (plan.metric === "seller_merchandise_sales") {
    return [
      "SELECT s.seller_id, SUM(CAST(oi.price AS REAL)) AS merchandise_sales, COUNT(*) AS units_sold",
      "FROM sellers s",
      "JOIN order_items oi ON oi.seller_id = s.seller_id",
      "GROUP BY s.seller_id",
      ...order(plan, "merchandise_sales"),
    ].join("\n");
  }

  if (plan.metric === "distinct_seller_count") {
    return "SELECT s.seller_state, COUNT(DISTINCT s.seller_id) AS seller_count\nFROM sellers s\nGROUP BY s.seller_state\nORDER BY s.seller_state";
  }

  throw new Error(`Unsupported query plan metric: ${plan.metric}`);
}
