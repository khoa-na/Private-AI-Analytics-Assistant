# DuckDB analytics playbook

Choose the output shape from the question before writing SQL. Do not add a
`GROUP BY` merely because an aggregate is present.

## Scalar aggregate

Questions asking "how many", one total, one minimum, one maximum, or one range
must return exactly one row unless they explicitly request groups.

## Grouped aggregate

Return one row per requested entity. `GROUP BY` contains only non-aggregate
entity or dimension columns. Aggregate expressions belong in `SELECT`,
`HAVING`, or `ORDER BY`, never in `GROUP BY` or `WHERE`.

## Count entities satisfying an aggregate condition

First compute one row per entity in a subquery or CTE. Apply the aggregate
condition there with `HAVING`, then count those rows in an outer query:

```sql
SELECT COUNT(*) AS entity_count
FROM (
  SELECT entity_id
  FROM fact
  GROUP BY entity_id
  HAVING aggregate_expression > threshold
) AS qualified_entities
```

The outer query must not group by `entity_id`; otherwise it returns one count
per entity instead of the requested total.

## Range of an entity-level aggregate

First calculate the metric at entity grain, then take `MIN` and `MAX` outside:

```sql
SELECT MIN(metric) AS min_metric, MAX(metric) AS max_metric
FROM (
  SELECT entity_id, aggregate_expression AS metric
  FROM fact
  GROUP BY entity_id
) AS entity_metrics
```

## Top or bottom N

Return entity label or ID, metric, and optional sample count. Group at entity
grain, order by the metric in the requested direction, and apply the requested
limit. Use a deterministic entity-key tie breaker.

## Multiple one-to-many facts

Aggregate each child table independently to the shared parent key, then join
the aggregates. Joining raw child tables first multiplies rows and corrupts
metrics.

Final check: the number and grain of result rows must match the wording of the
question, all joins must exist in the semantic model, and every selected
non-aggregate column must be a valid grouping column.
