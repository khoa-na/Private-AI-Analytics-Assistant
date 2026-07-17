import type { Row } from "./analyticsTypes";
import { getDb, readQuery } from "./db";
import { validateReadOnlySql } from "./sqlSafety";

export type QueryResult = {
  sql: string;
  columns: string[];
  rows: Row[];
  truncated: boolean;
};

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

export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const prepared = prepareReadOnlyQuery(sql);
  const db = await getDb();
  try {
    const result = await readQuery(db, prepared.executionSql);
    const rows = result.rows as Row[];
    return {
      sql: prepared.displaySql,
      columns: result.columns,
      rows: prepared.limit ? rows.slice(0, prepared.limit) : rows,
      truncated: prepared.limit !== undefined && rows.length > prepared.limit,
    };
  } finally {
    db.closeSync();
  }
}
