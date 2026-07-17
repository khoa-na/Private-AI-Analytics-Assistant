-- Independent source queries for evals/hm.json.
-- Active bundle: hm; schema_sha256:
-- 3d1fe96fb046a7145022a31cb03a90eefbbd0f9564e795fc3fbb37b9fbff2084
-- These queries return aggregates only and intentionally expose no identifiers.

SELECT
  COUNT(*) AS transaction_rows,
  COUNT(DISTINCT customer_id) AS observed_customers,
  COUNT(DISTINCT article_id) AS observed_articles,
  COUNT(DISTINCT t_dat) AS active_dates,
  MIN(t_dat) AS first_date,
  MAX(t_dat) AS last_date,
  SUM(price) AS recorded_price_sum,
  AVG(price) AS recorded_price_average,
  MIN(price) AS min_price,
  MAX(price) AS max_price
FROM transactions;

SELECT
  (SELECT COUNT(*) FROM articles) AS article_rows,
  (SELECT COUNT(*) FROM customers) AS customer_rows,
  (SELECT COUNT(*) FROM articles WHERE detail_desc IS NULL OR trim(detail_desc) = '')
    AS missing_detail_desc_rows,
  (SELECT COUNT(*) FROM articles WHERE product_type_no = -1)
    AS sentinel_product_type_rows,
  (SELECT COUNT(DISTINCT product_type_no) FROM articles WHERE product_type_name = 'Umbrella')
    AS umbrella_type_codes;

SELECT
  SUM(age IS NULL) AS null_age_rows,
  SUM(FN IS NULL) AS null_fn_rows,
  SUM(Active IS NULL) AS null_active_rows,
  SUM(club_member_status IS NULL OR trim(club_member_status) = '') AS missing_club_status_rows,
  SUM(fashion_news_frequency IS NULL OR trim(fashion_news_frequency) = '')
    AS missing_news_frequency_rows
FROM customers;

WITH seen_articles AS (
  SELECT DISTINCT article_id FROM transactions
), seen_customers AS (
  SELECT DISTINCT customer_id FROM transactions
)
SELECT
  (SELECT COUNT(*) FROM articles a LEFT JOIN seen_articles s USING (article_id)
    WHERE s.article_id IS NULL) AS untransacted_articles,
  (SELECT COUNT(*) FROM customers c LEFT JOIN seen_customers s USING (customer_id)
    WHERE s.customer_id IS NULL) AS nontransacting_customers,
  (SELECT COUNT(*) FROM transactions t LEFT JOIN articles a USING (article_id)
    WHERE a.article_id IS NULL) AS orphan_article_rows,
  (SELECT COUNT(*) FROM transactions t LEFT JOIN customers c USING (customer_id)
    WHERE c.customer_id IS NULL) AS orphan_customer_rows;

WITH daily AS (
  SELECT t_dat, COUNT(*) AS transaction_rows, SUM(price) AS recorded_price_sum
  FROM transactions
  GROUP BY t_dat
)
SELECT
  strftime(t_dat, '%Y-%m') AS month,
  SUM(transaction_rows) AS transaction_rows,
  SUM(recorded_price_sum) AS recorded_price_sum
FROM daily
GROUP BY month
ORDER BY month;

SELECT
  sales_channel_id,
  COUNT(*) AS transaction_rows,
  100.0 * COUNT(*) / SUM(COUNT(*)) OVER () AS row_share_pct,
  SUM(price) AS recorded_price_sum,
  AVG(price) AS recorded_price_average
FROM transactions
GROUP BY sales_channel_id
ORDER BY sales_channel_id;

WITH per_article AS (
  SELECT article_id, COUNT(*) AS transaction_rows
  FROM transactions
  GROUP BY article_id
)
SELECT
  a.product_group_name,
  COUNT(*) AS observed_articles,
  SUM(p.transaction_rows) AS transaction_rows
FROM per_article p
JOIN articles a USING (article_id)
GROUP BY a.product_group_name
ORDER BY transaction_rows DESC, a.product_group_name;

WITH per_customer AS (
  SELECT
    customer_id,
    COUNT(DISTINCT t_dat) AS active_dates,
    MAX(t_dat BETWEEN '2019-01-01' AND '2019-12-31') AS seen_2019,
    MAX(t_dat BETWEEN '2020-01-01' AND '2020-08-31') AS seen_2020_jan_aug
  FROM transactions
  GROUP BY customer_id
)
SELECT
  COUNT(*) AS observed_customers,
  SUM(active_dates = 1) AS one_date_customers,
  SUM(active_dates BETWEEN 2 AND 5) AS two_to_five_date_customers,
  SUM(active_dates BETWEEN 6 AND 10) AS six_to_ten_date_customers,
  SUM(active_dates > 10) AS over_ten_date_customers,
  SUM(active_dates >= 2) AS repeat_date_customers,
  SUM(seen_2019 = 1 AND seen_2020_jan_aug = 1) AS continuity_proxy_customers
FROM per_customer;

WITH daily AS (
  SELECT t_dat, COUNT(*) AS transaction_rows, SUM(price) AS recorded_price_sum
  FROM transactions
  GROUP BY t_dat
)
SELECT
  SUM(CASE WHEN t_dat BETWEEN '2019-01-01' AND '2019-12-31'
    THEN transaction_rows ELSE 0 END) AS rows_2019,
  SUM(CASE WHEN t_dat BETWEEN '2019-01-01' AND '2019-12-31'
    THEN recorded_price_sum ELSE 0 END) AS value_2019,
  SUM(CASE WHEN t_dat BETWEEN '2020-01-01' AND '2020-09-22'
    THEN transaction_rows ELSE 0 END) AS rows_2020_through_sep22,
  SUM(CASE WHEN t_dat BETWEEN '2020-01-01' AND '2020-09-22'
    THEN recorded_price_sum ELSE 0 END) AS value_2020_through_sep22
FROM daily;

SELECT
  COUNT(*) AS transaction_rows,
  (SELECT COUNT(*) FROM (
    SELECT t_dat, customer_id, article_id, price, sales_channel_id
    FROM transactions
    WHERE t_dat = '2019-09-28'
    GROUP BY t_dat, customer_id, article_id, price, sales_channel_id
  )) AS distinct_full_tuples
FROM transactions
WHERE t_dat = '2019-09-28';

SELECT
  COUNT(DISTINCT article_id) AS distinct_article_ids,
  COUNT(DISTINCT product_code) AS distinct_product_codes,
  COUNT(DISTINCT prod_name) AS distinct_product_names
FROM articles;

SELECT
  graphical_appearance_no,
  graphical_appearance_name,
  COUNT(*) AS catalog_articles
FROM articles
GROUP BY graphical_appearance_no, graphical_appearance_name
ORDER BY catalog_articles DESC, graphical_appearance_name
LIMIT 5;

SELECT
  colour_group_code,
  colour_group_name,
  perceived_colour_master_id,
  perceived_colour_master_name,
  perceived_colour_value_id,
  perceived_colour_value_name,
  COUNT(*) AS catalog_articles
FROM articles
GROUP BY
  colour_group_code,
  colour_group_name,
  perceived_colour_master_id,
  perceived_colour_master_name,
  perceived_colour_value_id,
  perceived_colour_value_name
ORDER BY
  catalog_articles DESC,
  colour_group_name,
  perceived_colour_master_name,
  perceived_colour_value_name
LIMIT 5;

SELECT
  COUNT(DISTINCT department_no || '|' || department_name) AS department_pairs,
  COUNT(DISTINCT index_code || '|' || index_name) AS index_pairs,
  COUNT(DISTINCT CAST(index_group_no AS TEXT) || '|' || index_group_name)
    AS index_group_pairs,
  COUNT(DISTINCT CAST(section_no AS TEXT) || '|' || section_name) AS section_pairs,
  COUNT(DISTINCT CAST(garment_group_no AS TEXT) || '|' || garment_group_name)
    AS garment_group_pairs
FROM articles;

WITH mapping_values AS (
  SELECT 'product_code_prod_name' AS mapping,
    CAST(product_code AS TEXT) AS code, prod_name AS name FROM articles
  UNION ALL SELECT 'product_type_no_product_type_name',
    CAST(product_type_no AS TEXT), product_type_name FROM articles
  UNION ALL SELECT 'graphical_appearance_no_graphical_appearance_name',
    CAST(graphical_appearance_no AS TEXT), graphical_appearance_name FROM articles
  UNION ALL SELECT 'colour_group_code_colour_group_name',
    CAST(colour_group_code AS TEXT), colour_group_name FROM articles
  UNION ALL SELECT 'perceived_colour_value_id_perceived_colour_value_name',
    CAST(perceived_colour_value_id AS TEXT), perceived_colour_value_name FROM articles
  UNION ALL SELECT 'perceived_colour_master_id_perceived_colour_master_name',
    CAST(perceived_colour_master_id AS TEXT), perceived_colour_master_name FROM articles
  UNION ALL SELECT 'department_no_department_name',
    CAST(department_no AS TEXT), department_name FROM articles
  UNION ALL SELECT 'index_code_index_name',
    CAST(index_code AS TEXT), index_name FROM articles
  UNION ALL SELECT 'index_group_no_index_group_name',
    CAST(index_group_no AS TEXT), index_group_name FROM articles
  UNION ALL SELECT 'section_no_section_name',
    CAST(section_no AS TEXT), section_name FROM articles
  UNION ALL SELECT 'garment_group_no_garment_group_name',
    CAST(garment_group_no AS TEXT), garment_group_name FROM articles
), code_counts AS (
  SELECT mapping, code, COUNT(DISTINCT name) AS name_count
  FROM mapping_values
  GROUP BY mapping, code
), name_counts AS (
  SELECT mapping, name, COUNT(DISTINCT code) AS code_count
  FROM mapping_values
  GROUP BY mapping, name
), code_issues AS (
  SELECT mapping, SUM(name_count > 1) AS codes_with_multiple_names
  FROM code_counts
  GROUP BY mapping
), name_issues AS (
  SELECT mapping, SUM(code_count > 1) AS names_with_multiple_codes
  FROM name_counts
  GROUP BY mapping
)
SELECT
  c.mapping,
  c.codes_with_multiple_names,
  n.names_with_multiple_codes
FROM code_issues c
JOIN name_issues n USING (mapping)
ORDER BY c.mapping;

WITH daily AS (
  SELECT t_dat, COUNT(*) AS transaction_rows
  FROM transactions
  WHERE t_dat BETWEEN '2019-01-07' AND '2020-01-05'
  GROUP BY t_dat
)
SELECT
  strftime(t_dat, '%w') AS weekday,
  COUNT(*) AS weekday_days,
  AVG(transaction_rows) AS avg_transaction_rows
FROM daily
GROUP BY weekday
ORDER BY avg_transaction_rows DESC, weekday;

WITH daily AS (
  SELECT t_dat, COUNT(*) AS transaction_rows
  FROM transactions
  WHERE t_dat BETWEEN '2018-10-01' AND '2020-08-31'
  GROUP BY t_dat
), ranked AS (
  SELECT
    transaction_rows,
    ROW_NUMBER() OVER (ORDER BY transaction_rows) AS rn,
    COUNT(*) OVER () AS n
  FROM daily
), quartiles AS (
  SELECT
    n AS day_count,
    MAX(CASE WHEN rn = CAST(n * 0.25 + 0.999999999 AS INTEGER)
      THEN transaction_rows END) AS p25,
    MAX(CASE WHEN rn = CAST(n * 0.50 + 0.999999999 AS INTEGER)
      THEN transaction_rows END) AS median,
    MAX(CASE WHEN rn = CAST(n * 0.75 + 0.999999999 AS INTEGER)
      THEN transaction_rows END) AS p75
  FROM ranked
)
SELECT
  day_count,
  p25,
  median,
  p75,
  p75 - p25 AS iqr,
  (SELECT COUNT(*) FROM daily
    WHERE transaction_rows > p75 + 1.5 * (p75 - p25)) AS high_outlier_days
FROM quartiles;

SELECT
  MAX(t_dat) AS last_date,
  date_diff('day', MAX(t_dat), DATE '2026-07-15') AS days_old
FROM transactions;

WITH daily AS (
  SELECT t_dat, COUNT(*) AS transaction_rows
  FROM transactions
  WHERE t_dat BETWEEN '2020-09-16' AND '2020-09-22'
  GROUP BY t_dat
)
SELECT
  '2020-09-22' AS as_of_date,
  COUNT(*) AS window_days,
  AVG(transaction_rows) AS rolling_7d_avg_rows
FROM daily;

WITH by_channel AS (
  SELECT
    sales_channel_id,
    COUNT(*) AS channel_rows,
    AVG(price) AS channel_average
  FROM transactions
  GROUP BY sales_channel_id
)
SELECT
  SUM(channel_rows * channel_average) / SUM(channel_rows) AS correct_overall_average,
  AVG(channel_average) AS naive_average_of_channel_averages,
  ABS(
    SUM(channel_rows * channel_average) / SUM(channel_rows) - AVG(channel_average)
  ) AS absolute_gap
FROM by_channel;

WITH bucketed AS (
  SELECT
    CASE
      WHEN price < 0.01 THEN '<0.01'
      WHEN price < 0.025 THEN '0.01-<0.025'
      WHEN price < 0.05 THEN '0.025-<0.05'
      ELSE '>=0.05'
    END AS price_bucket,
    CASE
      WHEN price < 0.01 THEN 1
      WHEN price < 0.025 THEN 2
      WHEN price < 0.05 THEN 3
      ELSE 4
    END AS bucket_order
  FROM transactions
)
SELECT price_bucket, COUNT(*) AS transaction_rows
FROM bucketed
GROUP BY price_bucket, bucket_order
ORDER BY bucket_order;

SELECT
  (SELECT SUM(customer_id IS NULL) FROM transactions) AS missing_customer_ids,
  (SELECT SUM(article_id IS NULL) FROM transactions) AS missing_article_ids,
  (SELECT SUM(sales_channel_id IS NULL OR sales_channel_id NOT IN (1, 2))
    FROM transactions) AS invalid_channel_rows,
  (SELECT SUM(t_dat IS NULL OR try_cast(t_dat AS DATE) IS NULL)
    FROM transactions) AS malformed_date_rows,
  (SELECT SUM(FN IS NOT NULL AND FN NOT IN (0, 1)) FROM customers) AS invalid_fn_rows,
  (SELECT SUM(Active IS NOT NULL AND Active NOT IN (0, 1))
    FROM customers) AS invalid_active_rows,
  (SELECT SUM(age IS NOT NULL AND (age < 0 OR age > 120))
    FROM customers) AS invalid_age_rows;

SELECT
  SUM(
    prod_name IS NULL OR trim(prod_name) = '' OR
    product_type_name IS NULL OR trim(product_type_name) = '' OR
    product_group_name IS NULL OR trim(product_group_name) = '' OR
    graphical_appearance_name IS NULL OR trim(graphical_appearance_name) = '' OR
    colour_group_name IS NULL OR trim(colour_group_name) = '' OR
    perceived_colour_value_name IS NULL OR trim(perceived_colour_value_name) = '' OR
    perceived_colour_master_name IS NULL OR trim(perceived_colour_master_name) = '' OR
    department_name IS NULL OR trim(department_name) = '' OR
    index_name IS NULL OR trim(index_name) = '' OR
    index_group_name IS NULL OR trim(index_group_name) = '' OR
    section_name IS NULL OR trim(section_name) = '' OR
    garment_group_name IS NULL OR trim(garment_group_name) = ''
  ) AS missing_classification_name_rows,
  SUM(detail_desc IS NULL OR trim(detail_desc) = '') AS missing_detail_desc_rows,
  SUM(
    product_type_no = -1 OR graphical_appearance_no = -1 OR
    perceived_colour_value_id = -1 OR perceived_colour_master_id = -1 OR
    department_no = -1 OR index_group_no = -1 OR section_no = -1 OR
    garment_group_no = -1
  ) AS sentinel_classification_rows
FROM articles;

WITH per_postal_code AS (
  SELECT postal_code, COUNT(*) AS customer_count
  FROM customers
  GROUP BY postal_code
), bucketed AS (
  SELECT
    CASE
      WHEN customer_count = 1 THEN '1'
      WHEN customer_count BETWEEN 2 AND 9 THEN '2-9'
      WHEN customer_count BETWEEN 10 AND 99 THEN '10-99'
      ELSE '100+'
    END AS group_size_bucket,
    CASE
      WHEN customer_count = 1 THEN 1
      WHEN customer_count BETWEEN 2 AND 9 THEN 2
      WHEN customer_count BETWEEN 10 AND 99 THEN 3
      ELSE 4
    END AS bucket_order,
    customer_count
  FROM per_postal_code
)
SELECT
  group_size_bucket,
  COUNT(*) AS postal_code_count,
  SUM(customer_count) AS customer_count
FROM bucketed
GROUP BY group_size_bucket, bucket_order
ORDER BY bucket_order;

SELECT
  CASE
    WHEN c.age IS NULL THEN 'missing'
    WHEN c.age BETWEEN 16 AND 19 THEN '16-19'
    WHEN c.age BETWEEN 20 AND 29 THEN '20-29'
    WHEN c.age BETWEEN 30 AND 39 THEN '30-39'
    WHEN c.age BETWEEN 40 AND 49 THEN '40-49'
    WHEN c.age BETWEEN 50 AND 59 THEN '50-59'
    WHEN c.age BETWEEN 60 AND 69 THEN '60-69'
    WHEN c.age >= 70 THEN '70+'
    ELSE 'under-16'
  END AS age_band,
  a.product_group_name,
  COUNT(DISTINCT t.customer_id) AS observed_customers,
  COUNT(*) AS transaction_rows
FROM transactions t
JOIN customers c USING (customer_id)
JOIN articles a USING (article_id)
WHERE t.t_dat = '2019-09-28'
GROUP BY age_band, a.product_group_name
HAVING observed_customers >= 100
ORDER BY transaction_rows DESC, age_band, a.product_group_name
LIMIT 10;

SELECT t_dat AS peak_date, COUNT(*) AS transaction_rows
FROM transactions
WHERE t_dat BETWEEN '2019-01-01' AND '2019-12-31'
GROUP BY t_dat
ORDER BY transaction_rows DESC, t_dat
LIMIT 1;

SELECT sales_channel_id, COUNT(*) AS transaction_rows
FROM transactions
WHERE t_dat = '2019-09-28'
GROUP BY sales_channel_id
ORDER BY transaction_rows DESC, sales_channel_id;

SELECT a.product_group_name, COUNT(*) AS transaction_rows
FROM transactions t
JOIN articles a USING (article_id)
WHERE t.t_dat = '2019-09-28'
GROUP BY a.product_group_name
ORDER BY transaction_rows DESC, a.product_group_name
LIMIT 5;

SELECT prod_name, COUNT(*) AS catalog_articles
FROM articles
GROUP BY prod_name
ORDER BY catalog_articles DESC, prod_name;

SELECT strftime(t_dat, '%Y-%m') AS month, COUNT(*) AS transaction_rows
FROM transactions
WHERE t_dat BETWEEN '2021-01-01' AND '2021-12-31'
GROUP BY month
ORDER BY month;
