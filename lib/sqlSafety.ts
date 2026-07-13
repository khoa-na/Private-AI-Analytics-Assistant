import sqlParser from "node-sql-parser";

const { Parser } = sqlParser as unknown as {
  Parser: new () => { astify: (sql: string, options: { database: string }) => unknown };
};
const parser = new Parser();
const BLOCKED_SQL =
  /\b(ALTER|ATTACH|BEGIN|COMMIT|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REPLACE|ROLLBACK|TRUNCATE|UPDATE|VACUUM)\b/i;

export function validateReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("SQL is required.");
  if (BLOCKED_SQL.test(trimmed)) throw new Error("Only read-only SELECT queries are allowed.");
  if (!/^(?:SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT queries are allowed.");
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: "sqlite" });
  } catch {
    // SQLite is the syntax authority; node-sql-parser lacks parts of its dialect.
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
