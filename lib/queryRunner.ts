import type { Row } from "./analyticsTypes";
import { getDb } from "./db";
import { withDefaultLimit } from "./sqlSafety";

export type QueryResult = {
  sql: string;
  columns: string[];
  rows: Row[];
};

type QueryPlanRow = { detail: string };

export function validateQueryPlan(plan: QueryPlanRow[]) {
  if (plan.some(({ detail }) => /CORRELATED .*SUBQUERY/i.test(detail))) {
    throw new Error(
      "Correlated subqueries are not supported. Rewrite the query using JOINs.",
    );
  }
}

export function runReadOnlyQuery(sql: string): QueryResult {
  const safeSql = withDefaultLimit(sql);
  const db = getDb();

  try {
    validateQueryPlan(
      db.prepare(`EXPLAIN QUERY PLAN ${safeSql}`).all() as QueryPlanRow[],
    );
    const statement = db.prepare(safeSql);
    return {
      sql: safeSql,
      columns: statement.columns().map((column) => column.name),
      rows: statement.all() as Row[],
    };
  } finally {
    db.close();
  }
}
