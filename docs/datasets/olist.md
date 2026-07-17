# Olist dataset guide

## Scope

This is an anonymized Brazilian ecommerce dataset. Product titles are not
available; `product_id` identifies an individual product and category names are
the most readable product labels.

CSV columns are inferred by DuckDB. Use the active schema types and cast only
when a source column was inferred as text. Missing CSV values are usually null.

## Table grain

- `orders`: one row per order. `order_id` is the key.
- `customers`: one row per order-specific customer ID. Use
  `customer_unique_id` to identify a person across orders.
- `order_items`: one row per item position in an order. The key is
  (`order_id`, `order_item_id`).
- `order_payments`: one row per payment transaction or method used by an order.
- `order_reviews`: review records associated with an order.
- `products`: one row per anonymized product.
- `sellers`: one row per seller.
- `category_translation`: one row per Portuguese category name.
- `geolocation`: multiple coordinate rows per ZIP-code prefix; aggregate it
  before joining to avoid multiplying results.

## Data model contract

### Join policy

Treat the relationships below as a graph. Every cross-table `JOIN ... ON` must
use one declared graph edge. Column names, matching suffixes, or compatible
types are not evidence of a relationship.

If two required tables have no direct edge, traverse the graph through the
necessary intermediate tables. Never jump between unrelated identifiers.

### Relationship graph

- `customers.customer_id -> orders.customer_id` (order-specific customer to order)
- `orders.order_id -> order_items.order_id` (one order to many item rows)
- `orders.order_id -> order_payments.order_id` (one order to many payment rows)
- `orders.order_id -> order_reviews.order_id` (one order to review records)
- `order_reviews.order_id <-> order_items.order_id` (shared-order bridge for
  attributing order reviews to products; this expands one review across items)
- `products.product_id -> order_items.product_id` (one product to many item rows)
- `sellers.seller_id -> order_items.seller_id` (one seller to many item rows)
- `category_translation.product_category_name -> products.product_category_name`
  (one translation to products in that category)
- `geolocation.geolocation_zip_code_prefix -> customers.customer_zip_code_prefix`
- `geolocation.geolocation_zip_code_prefix -> sellers.seller_zip_code_prefix`

`geolocation_zip_code_prefix` is not unique in `geolocation`. Aggregate
geolocation to one row per prefix before using either geolocation edge.

### Path selection procedure

For every question:

1. Choose the fact table whose grain matches the requested metric.
2. Choose the dimension tables needed for labels or grouping.
3. Find a path between those tables using only relationship graph edges.
4. Add every intermediate table on that path; do not replace the path with a
   comparison between unrelated IDs.
5. Check the cardinality of every edge before aggregating.
6. If multiple one-to-many children of `orders` are needed, aggregate each child
   to `order_id` first and then join the aggregates.

### Common traversal patterns

- Reviews by product/category:
  `order_reviews -> orders/order_items -> products -> category_translation`.
  The executable bridge is
  `order_reviews.order_id = order_items.order_id`, followed by
  `order_items.product_id = products.product_id`.
- Customer behavior: `customers -> orders -> order_items/order_payments`.
- Seller or product performance: `sellers/products -> order_items -> orders`.
- Payment versus review analysis: aggregate payments and reviews independently
  by `order_id`, then join those aggregates through `orders`.

## Metric rules

- Merchandise sales: `SUM(CAST(order_items.price AS REAL))`.
- Customer-paid order value: aggregate `order_payments.payment_value` by order.
- Delivered revenue including freight: sum item `price + freight_value` for
  orders where `order_status = 'delivered'`.
- Units sold: count rows in `order_items`.
- Order count: `COUNT(DISTINCT order_id)`.
- Customer count: use `COUNT(DISTINCT customer_unique_id)` when measuring people.
- "Product rating" or "điểm đánh giá của sản phẩm" means
  `AVG(CAST(review_score AS REAL))` at product grain. Rating thresholds apply to
  that aggregate with `HAVING`, not to individual review rows.
- Use a row-level review filter only when the question explicitly says
  "at least one review", "individual reviews", or equivalent wording.
- Product review metrics always join `order_reviews r` to `order_items oi` with
  `r.order_id = oi.order_id`. Count reviewed orders with
  `COUNT(DISTINCT r.order_id)` when a sample count is needed.
- Delivery delay compares `order_delivered_customer_date` with
  `order_estimated_delivery_date` only when both values are non-empty.

## Query construction rules

- Give every table a short alias and qualify every column reference.
- Preserve the fact-table grain until the intended aggregation step.
- Do not combine multiple one-to-many children before pre-aggregation; doing so
  multiplies money, units, reviews, and payment counts.
- Use `COUNT(DISTINCT key)` when counting entities after a one-to-many join.
- Category translation is optional, so use a `LEFT JOIN` and fall back to the
  Portuguese category name.
- Do not invent product names. Use category plus a shortened or full
  `product_id` when a product label is required.

Before returning SQL, verify that every join follows a declared edge, every
required intermediate table is present, and the final aggregation matches the
business entity requested by the user.
