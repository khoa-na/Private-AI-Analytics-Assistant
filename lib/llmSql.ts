import { getSchemaText } from "./schema";
import { completeChat } from "./llmClient";
import { extractSqlFromModelOutput } from "./sqlExtraction";
import { withDefaultLimit } from "./sqlSafety";

export async function generateSql(question: string) {
  const output = await completeChat(
    [
      {
        role: "system",
        content: [
          "You generate SQLite SELECT queries for ecommerce analytics.",
          "Questions can be written in English or Vietnamese; translate the user intent internally.",
          "Return only the SQL query. Do not return markdown, JSON, explanations, or comments.",
          "The SQL must answer the exact current user question, not a previous or example question.",
          "The SQL must be one read-only SELECT statement.",
          "Use only tables and columns from the schema.",
          "Cast numeric CSV text fields with CAST(column AS REAL) before math.",
          "CSV missing values are empty strings; exclude them when grouping dates or numbers.",
          "Use explicit JOINs instead of correlated subqueries.",
          "For every product or category review question, join order_reviews to order_items on order_id, then products on product_id, and optionally category_translation on product_category_name.",
          "For rankings, select only the requested label or ID, metric, and a sample count; do not select unrelated columns.",
          "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, or multiple statements.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Schema:\n${getSchemaText()}`,
          "Example:",
          "Question: Top 5 products by average review score?",
          "SQL: SELECT p.product_id, ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score, COUNT(DISTINCT r.order_id) AS reviewed_orders FROM order_reviews r JOIN order_items oi ON r.order_id = oi.order_id JOIN products p ON oi.product_id = p.product_id GROUP BY p.product_id HAVING COUNT(DISTINCT r.order_id) >= 5 ORDER BY avg_review_score DESC, reviewed_orders DESC LIMIT 5",
          `Question: ${question}`,
        ].join("\n\n"),
      },
    ],
    { maxTokens: 320, temperature: 0.1 },
  );

  return withDefaultLimit(extractSqlFromModelOutput(output));
}
