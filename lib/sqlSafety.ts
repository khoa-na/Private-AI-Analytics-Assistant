import sqlParser from "node-sql-parser";

const { Parser } = sqlParser as unknown as {
  Parser: new () => { astify: (sql: string, options: { database: string }) => unknown };
};
const parser = new Parser();
const BLOCKED_SQL =
  /\b(ALTER|ATTACH|BEGIN|CALL|COMMIT|COPY|CREATE|DELETE|DETACH|DROP|EXPORT|IMPORT|INSERT|INSTALL|LOAD|PRAGMA|REPLACE|RESET|ROLLBACK|SET|TRUNCATE|UPDATE|VACUUM)\b/i;
const EXTERNAL_SCAN = /\b(?:read_csv|read_json|read_parquet|glob|sqlite_scan|postgres_scan|mysql_scan|httpfs)\s*\(/i;

export function validateReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("SQL is required.");
  if (BLOCKED_SQL.test(trimmed)) throw new Error("Only read-only SELECT queries are allowed.");
  if (EXTERNAL_SCAN.test(trimmed)) throw new Error("External files and databases are not accessible.");
  if (!/^(?:SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT queries are allowed.");
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: "postgresql" });
  } catch {
    // DuckDB is the syntax authority; node-sql-parser lacks parts of its dialect.
    if (trimmed.includes(";")) throw new Error("Only a single SELECT statement is allowed.");
    return trimmed;
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || statements[0]?.type !== "select") {
    throw new Error("Only a single SELECT statement is allowed.");
  }

  return trimmed;
}

export function withDefaultLimit(sql: string, limit = 1000) {
  const safeSql = validateReadOnlySql(sql);
  if (/\blimit\s+\d+/i.test(safeSql)) return safeSql;
  return `${safeSql} LIMIT ${limit}`;
}
