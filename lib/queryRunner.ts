import type { Row } from "./analyticsTypes";
import { getDb } from "./db";
import { validateReadOnlySql } from "./sqlSafety";

export type QueryResult = {
  sql: string;
  columns: string[];
  rows: Row[];
  truncated: boolean;
};

type QueryPlanRow = { detail: string };

export function validateQueryPlan(plan: QueryPlanRow[]) {
  if (plan.some(({ detail }) => /CORRELATED .*SUBQUERY/i.test(detail))) {
    throw new Error(
      "Correlated subqueries are not supported. Rewrite the query using JOINs.",
    );
  }
}

export function prepareReadOnlyQuery(sql: string, limit = 1000) {
  const safeSql = validateReadOnlySql(sql);
  if (/\blimit\s+\d+(?:\s+offset\s+\d+)?\s*$/i.test(safeSql)) {
    return { displaySql: safeSql, executionSql: safeSql, limit: undefined };
  }
  return {
    displaySql: `${safeSql} LIMIT ${limit}`,
    executionSql: `${safeSql} LIMIT ${limit + 1}`,
    limit,
  };
}

export function runReadOnlyQuery(sql: string): QueryResult {
  const prepared = prepareReadOnlyQuery(sql);
  const db = getDb();

  try {
    validateQueryPlan(
      db.prepare(`EXPLAIN QUERY PLAN ${prepared.executionSql}`).all() as QueryPlanRow[],
    );
    const statement = db.prepare(prepared.executionSql);
    const rows = statement.all() as Row[];
    return {
      sql: prepared.displaySql,
      columns: statement.columns().map((column) => column.name),
      rows: prepared.limit ? rows.slice(0, prepared.limit) : rows,
      truncated: prepared.limit !== undefined && rows.length > prepared.limit,
    };
  } finally {
    db.close();
  }
}
