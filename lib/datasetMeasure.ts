import { DuckDBInstance } from "@duckdb/node-api";
import sqlParser from "node-sql-parser";
import { queryRows } from "./db";
import type { DatasetProfile } from "./datasetImport";

const { Parser } = sqlParser as unknown as {
  Parser: new () => {
    astify: (sql: string, options: { database: string }) => unknown;
    columnList: (sql: string, options: { database: string }) => string[];
  };
};
const parser = new Parser();
const BLOCKED_EXPRESSION = /;|--|\/\*|\*\/|\b(?:SELECT|FROM|JOIN|WITH|COPY|ATTACH|ALTER|CREATE|DELETE|DROP|INSERT|INSTALL|LOAD|PRAGMA|SET|UPDATE)\b/i;
const BLOCKED_FUNCTION = /\b(?:RANDOM|GEN_RANDOM_UUID|UUID|READ_CSV|READ_JSON|READ_PARQUET)\s*\(/i;
const AGGREGATE = /\b(?:AVG|COUNT|MAX|MIN|SUM)\s*\(/i;

export type MeasureDefinition = { baseTable: string; expression: string; columns: string[] };
export type MeasureValidation = {
  status: "passed" | "failed";
  checks: { structure: boolean; syntax: boolean; references: boolean; sampleExecution: boolean };
  errors: string[];
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function validateMeasureDefinition(
  measure: MeasureDefinition,
  profile: DatasetProfile,
): Promise<MeasureValidation> {
  const errors: string[] = [];
  const checks = { structure: false, syntax: false, references: false, sampleExecution: false };
  const table = profile.tables.find(({ name }) => name === measure.baseTable);
  const declaredColumns = new Set(measure.columns);
  const availableColumns = new Set(table?.columns.map(({ name }) => `${measure.baseTable}.${name}`) ?? []);

  if (!table) errors.push(`Base table not found: ${measure.baseTable}`);
  if (!measure.expression.trim() || measure.expression.length > 500) errors.push("Expression must contain 1-500 characters.");
  if (BLOCKED_EXPRESSION.test(measure.expression)) errors.push("Expression contains blocked SQL syntax.");
  if (BLOCKED_FUNCTION.test(measure.expression)) errors.push("Expression contains a nondeterministic or external function.");
  if (!AGGREGATE.test(measure.expression)) errors.push("Expression must contain an aggregate function.");
  if (!Array.isArray(measure.columns) || measure.columns.some((column) => !availableColumns.has(column))) {
    errors.push("Every declared measure column must belong to the base table.");
  }
  checks.structure = errors.length === 0;

  let referencedColumns: string[] = [];
  if (checks.structure) {
    const sql = `SELECT ${measure.expression} AS value FROM ${quoteIdentifier(measure.baseTable)}`;
    try {
      const ast = parser.astify(sql, { database: "postgresql" });
      if (Array.isArray(ast) || !ast || (ast as { type?: string }).type !== "select") throw new Error("Invalid expression AST.");
      referencedColumns = parser.columnList(sql, { database: "postgresql" }).map((reference) => {
        const [, tableName, column] = reference.split("::");
        return tableName && tableName !== "null" ? `${tableName}.${column}` : column;
      });
      checks.syntax = true;
    } catch {
      errors.push("Expression could not be parsed as one DuckDB aggregate expression.");
    }
  }

  if (checks.syntax) {
    const actualColumns = new Set(referencedColumns);
    if (!referencedColumns.every((column) => column.includes("."))) errors.push("Every referenced column must be qualified as table.column.");
    if ([...actualColumns].some((column) => !availableColumns.has(column))) errors.push("Expression references a column outside the base table.");
    if (actualColumns.size !== declaredColumns.size || [...actualColumns].some((column) => !declaredColumns.has(column))) {
      errors.push("Expression references must exactly match the declared columns.");
    }
    checks.references = errors.length === 0;
  }

  if (checks.references) {
    const instance = await DuckDBInstance.create(profile.databasePath, { access_mode: "READ_ONLY" });
    const db = await instance.connect();
    try {
      const sql = `SELECT ${measure.expression} AS value FROM (` +
        `SELECT * FROM ${quoteIdentifier(measure.baseTable)} LIMIT 1000` +
        `) AS ${quoteIdentifier(measure.baseTable)}`;
      const first = (await queryRows(db, sql))[0]?.value;
      const second = (await queryRows(db, sql))[0]?.value;
      if (first === null || first === undefined) throw new Error("Expression returned no value for a non-empty sample.");
      if (typeof first === "number" && !Number.isFinite(first)) throw new Error("Expression returned a non-finite number.");
      if (!Object.is(first, second)) throw new Error("Expression returned different values for the same sample.");
      checks.sampleExecution = true;
    } catch (error) {
      errors.push(`Sample execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.closeSync();
      instance.closeSync();
    }
  }

  return { status: errors.length ? "failed" : "passed", checks, errors };
}
