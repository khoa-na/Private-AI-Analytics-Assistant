import { DatabaseSync } from "node:sqlite";
import sqlParser from "node-sql-parser";
import type { DatasetProfile } from "./datasetImport";

const { Parser } = sqlParser as unknown as {
  Parser: new () => {
    astify: (sql: string, options: { database: string }) => unknown;
    columnList: (sql: string, options: { database: string }) => string[];
  };
};
const parser = new Parser();
const BLOCKED_EXPRESSION = /;|--|\/\*|\*\/|\b(?:SELECT|FROM|JOIN|WITH|PRAGMA|ATTACH|ALTER|CREATE|DELETE|DROP|INSERT|UPDATE)\b/i;
const BLOCKED_FUNCTION = /\b(?:RANDOM|RANDOMBLOB|ZEROBLOB|LOAD_EXTENSION)\s*\(/i;
const AGGREGATE = /\b(?:AVG|COUNT|MAX|MIN|SUM)\s*\(/i;

export type MeasureDefinition = {
  baseTable: string;
  expression: string;
  columns: string[];
};

export type MeasureValidation = {
  status: "passed" | "failed";
  checks: {
    structure: boolean;
    syntax: boolean;
    references: boolean;
    sampleExecution: boolean;
  };
  errors: string[];
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function validateMeasureDefinition(measure: MeasureDefinition, profile: DatasetProfile): MeasureValidation {
  const errors: string[] = [];
  const checks = { structure: false, syntax: false, references: false, sampleExecution: false };
  const table = profile.tables.find(({ name }) => name === measure.baseTable);
  const declaredColumns = new Set(measure.columns);
  const availableColumns = new Set(table?.columns.map(({ name }) => `${measure.baseTable}.${name}`) ?? []);

  if (!table) errors.push(`Base table not found: ${measure.baseTable}`);
  if (!measure.expression.trim() || measure.expression.length > 500) errors.push("Expression must contain 1-500 characters.");
  if (BLOCKED_EXPRESSION.test(measure.expression)) errors.push("Expression contains blocked SQL syntax.");
  if (BLOCKED_FUNCTION.test(measure.expression)) errors.push("Expression contains a nondeterministic or allocating function.");
  if (!AGGREGATE.test(measure.expression)) errors.push("Expression must contain an aggregate function.");
  if (!Array.isArray(measure.columns) || measure.columns.some((column) => !availableColumns.has(column))) {
    errors.push("Every declared measure column must belong to the base table.");
  }
  checks.structure = errors.length === 0;

  let referencedColumns: string[] = [];
  if (checks.structure) {
    const sql = `SELECT ${measure.expression} AS value FROM ${quoteIdentifier(measure.baseTable)}`;
    try {
      const ast = parser.astify(sql, { database: "sqlite" });
      if (Array.isArray(ast) || !ast || (ast as { type?: string }).type !== "select") throw new Error("Invalid expression AST.");
      referencedColumns = parser.columnList(sql, { database: "sqlite" }).map((reference) => {
        const [, tableName, column] = reference.split("::");
        return tableName && tableName !== "null" ? `${tableName}.${column}` : column;
      });
      checks.syntax = true;
    } catch {
      errors.push("Expression could not be parsed as one SQLite aggregate expression.");
    }
  }

  if (checks.syntax) {
    const qualified = referencedColumns.every((column) => column.includes("."));
    const actualColumns = new Set(referencedColumns);
    if (!qualified) errors.push("Every referenced column must be qualified as table.column.");
    if ([...actualColumns].some((column) => !availableColumns.has(column))) errors.push("Expression references a column outside the base table.");
    if (actualColumns.size !== declaredColumns.size || [...actualColumns].some((column) => !declaredColumns.has(column))) {
      errors.push("Expression references must exactly match the declared columns.");
    }
    checks.references = errors.length === 0;
  }

  if (checks.references) {
    const db = new DatabaseSync(profile.databasePath, { readOnly: true });
    try {
      const statement = db.prepare(
        `SELECT ${measure.expression} AS value FROM (SELECT * FROM ${quoteIdentifier(measure.baseTable)} LIMIT 1000) AS ${quoteIdentifier(measure.baseTable)}`,
      );
      const first = (statement.get() as { value: unknown }).value;
      const second = (statement.get() as { value: unknown }).value;
      if (first === null || first === undefined) throw new Error("Expression returned no value for a non-empty sample.");
      if (typeof first === "number" && !Number.isFinite(first)) throw new Error("Expression returned a non-finite number.");
      if (!Object.is(first, second)) throw new Error("Expression returned different values for the same sample.");
      checks.sampleExecution = true;
    } catch (error) {
      errors.push(`Sample execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  }

  return { status: errors.length ? "failed" : "passed", checks, errors };
}
