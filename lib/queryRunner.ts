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
  const tableReads = plan.filter(({ detail }) => /^(?:SCAN\s+(?!CONSTANT\b)|SEARCH\s+)/i.test(detail)).length;
  if (tableReads > 1 && plan.some(({ detail }) => /USE TEMP B-TREE FOR DISTINCT/i.test(detail))) {
    throw new Error(
      "DISTINCT across a multi-table query is too expensive. Count a stable key in one joined aggregate.",
    );
  }
}

export function prepareReadOnlyQuery(sql: string, limit = 1000) {
  const safeSql = validateReadOnlySql(sql);
  const explicitLimit = safeSql.match(/\blimit\s+(\d+)(?:\s+offset\s+\d+)?\s*$/i);
  if (explicitLimit && Number(explicitLimit[1]) <= limit) {
    return { displaySql: safeSql, executionSql: safeSql, limit: undefined };
  }
  const boundedSql = /\blimit\b/i.test(safeSql) ? `SELECT * FROM (${safeSql})` : safeSql;
  return {
    displaySql: `${boundedSql} LIMIT ${limit}`,
    executionSql: `${boundedSql} LIMIT ${limit + 1}`,
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
