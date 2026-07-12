import { completeChat, tokenBudget } from "./llmClient";
import {
  compileQueryPlan,
  DIMENSIONS,
  METRICS,
  parsePlannedIntent,
} from "./queryPlan";

export async function tryGenerateQueryPlan(question: string) {
  const request = (correction?: string) => completeChat(
    [
      {
        role: "system",
        content: [
          "Classify the analytics request and return only JSON.",
          "Use intent=multi_query only when answering requires two or three independently executable aggregate queries. Every step must have kind=query and produce database rows; synthesis is never a step. Each step question must be self-contained, copy the original time and entity filters, and declare its required result grain. Never use multi_query when one grouped SQL query is sufficient.",
          "Use intent=query for analytics questions representable by the supported metrics and dimensions.",
          "merchandise_sales means SUM(order_items.price), never freight.",
          "average_delivered_order_revenue means average per-order SUM(price) for delivered orders.",
          "purchase_month always comes from orders.order_purchase_timestamp.",
          "For comparisons across years use both purchase_year and purchase_month plus years.",
          "When the question explicitly names calendar years, copy every named year into years; never omit the year filter.",
          "Never add a dimension, sort, limit, or year unless the question explicitly asks for it.",
          "A total revenue question has dimensions=[] and no sort or limit.",
          "Revenue by month has dimensions=[purchase_month].",
          "The highest revenue month has dimensions=[purchase_month], sort=desc, limit=1.",
          "Average revenue per delivered order has metric=average_delivered_order_revenue, dimensions=[], and no sort, limit, or years.",
          "product_average_review uses minimumCount for a minimum reviewed-order sample; product_count_above_average_review uses threshold; product_count_with_review_score uses reviewScore.",
          "Average review by product category is supported: use product_average_review with dimensions=[product_category] and minimumCount for the reviewed-order threshold.",
          "Products never sold uses unsold_product_count. Product-level sales min-to-max uses product_sales_range. Product count by category uses distinct_product_count with product_category.",
          "Product merchandise_sales is sourced from order_items, so every returned product has already sold at least once; do not add a threshold or mark that request unsupported.",
          "late_order_count groups by purchase_month when asked by month. late_delivery_rate groups by customer_state when asked by state.",
          "payment_value groups by payment_type. multi_payment_method_order_count means distinct payment methods, not payment rows.",
          "repeat_customer_count uses minimumCount=1 for more than one order.",
          "customer_merchandise_sales always uses dimensions=[customer]. seller_merchandise_sales always uses dimensions=[seller]. distinct_order_count by state uses dimensions=[customer_state]. distinct_seller_count by state uses dimensions=[seller_state].",
          "In Vietnamese, number words before an entity (for example 'năm khách hàng' or 'năm danh mục') are quantities and must become limit values; calendar years are explicit four-digit years or follow phrases such as 'năm 2017'.",
          "Use sort and limit only for top, bottom, highest, or lowest questions.",
          "Use clarification for ambiguous requests, unsupported for unavailable product titles or forecasting, refusal for unsafe requests, and fallback only when no supported metric fits.",
          "Any request for a product name, title, or official name is unsupported because Olist has only product IDs and categories; do not substitute an ID or category name.",
          "A request for the 'best product' without defining best is clarification, not unsupported; ask whether best means sales, units, or rating.",
          "A late-order count has dimensions=[] unless the question explicitly says by month; never infer a time dimension.",
          "The payment method with the highest total value uses payment_value, dimensions=[payment_type], sort=desc, limit=1.",
          "Forecasting or predicting future values is always unsupported, never clarification.",
          "Requests to execute raw SQL control or schema commands such as PRAGMA, ATTACH, DROP, DELETE, INSERT, or UPDATE are always refusal.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          supported: {
            metrics: METRICS,
            dimensions: DIMENSIONS,
          },
          shape: {
            intent: "query|multi_query|clarification|unsupported|refusal|fallback",
            metric: "supported metric, required for query",
            dimensions: ["supported dimensions, required for query"],
            years: ["optional integer years"],
            threshold: "optional numeric metric threshold",
            minimumCount: "optional numeric minimum sample/entity count",
            reviewScore: "optional numeric review score",
            sort: "optional asc|desc",
            limit: "optional integer",
            message: "required for clarification, unsupported, or refusal",
            steps: [{ kind: "query", purpose: "data-producing purpose", question: "self-contained analytics question", requiredGrain: "result row grain", filters: ["copied original filters"] }],
          },
        }),
      },
      ...(correction
        ? [{ role: "user" as const, content: `Your previous plan was invalid: ${correction} Return a corrected plan for the same question.` }]
        : []),
    ],
    {
      maxTokens: tokenBudget("OPENAI_PLAN_MAX_TOKENS", 2400),
      reasoningEffort: "low",
      temperature: 0,
      responseFormat: {
        type: "json_object",
        schema: {
          type: "object",
          required: ["intent"],
          properties: {
            intent: {
              type: "string",
              enum: ["query", "multi_query", "clarification", "unsupported", "refusal", "fallback"],
            },
            metric: { type: "string", enum: METRICS },
            dimensions: {
              type: "array",
              items: { type: "string", enum: DIMENSIONS },
            },
            years: { type: "array", items: { type: "integer" } },
            threshold: { type: "number" },
            minimumCount: { type: "number" },
            reviewScore: { type: "number" },
            sort: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "integer", minimum: 1, maximum: 1000 },
            message: { type: "string" },
            steps: {
              type: "array",
              minItems: 2,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "purpose", "question", "requiredGrain", "filters"],
                properties: {
                  kind: { type: "string", enum: ["query"] },
                  purpose: { type: "string" },
                  question: { type: "string" },
                  requiredGrain: { type: "string" },
                  filters: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  );
  const resolve = (output: string) => {
    const plan = parsePlannedIntent(output);
    if (plan.intent === "fallback") return;
    if (plan.intent !== "query") return plan;
    return compileQueryPlan(plan);
  };

  try {
    return resolve(await request());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid query plan.";
    return resolve(await request(reason));
  }
}
