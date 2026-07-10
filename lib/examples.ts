export const EXAMPLES = [
  {
    label: "Monthly revenue",
    question: "What is monthly delivered revenue?",
    sql: `SELECT
  strftime('%Y-%m', o.order_purchase_timestamp) AS month,
  ROUND(SUM(CAST(oi.price AS REAL) + CAST(oi.freight_value AS REAL)), 2) AS revenue
FROM orders o
JOIN order_items oi ON o.order_id = oi.order_id
WHERE o.order_status = 'delivered'
GROUP BY month
ORDER BY month`,
  },
  {
    label: "Top categories",
    question: "Which product categories generated the most sales?",
    sql: `SELECT
  COALESCE(t.product_category_name_english, p.product_category_name) AS category,
  ROUND(SUM(CAST(oi.price AS REAL)), 2) AS sales
FROM order_items oi
JOIN products p ON oi.product_id = p.product_id
LEFT JOIN category_translation t
  ON p.product_category_name = t.product_category_name
GROUP BY category
ORDER BY sales DESC
LIMIT 15`,
  },
  {
    label: "Review by payment",
    question: "What is the average review score by payment type?",
    sql: `SELECT
  pay.payment_type,
  ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score,
  COUNT(*) AS orders
FROM order_payments pay
JOIN order_reviews r ON pay.order_id = r.order_id
GROUP BY pay.payment_type
ORDER BY avg_review_score DESC`,
  },
  {
    label: "Lowest reviewed categories",
    question: "Danh mục sản phẩm nào có điểm đánh giá trung bình thấp nhất?",
    sql: `SELECT
  COALESCE(t.product_category_name_english, p.product_category_name) AS category,
  ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score,
  COUNT(DISTINCT r.order_id) AS reviewed_orders
FROM order_reviews r
JOIN order_items oi ON r.order_id = oi.order_id
JOIN products p ON oi.product_id = p.product_id
LEFT JOIN category_translation t
  ON p.product_category_name = t.product_category_name
GROUP BY category
HAVING reviewed_orders >= 20
ORDER BY avg_review_score ASC, reviewed_orders DESC
LIMIT 15`,
  },
] as const;
