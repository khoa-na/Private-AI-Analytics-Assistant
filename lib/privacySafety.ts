import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sqlParser from "node-sql-parser";
import { getDatabasePath } from "./db";

const { Parser } = sqlParser as unknown as {
  Parser: new () => { astify: (sql: string, options: { database: string }) => unknown };
};
const parser = new Parser();

type PrivacyClass = "none" | "identifier" | "quasi_identifier" | "direct_identifier" | "free_text";
export type PrivacyCatalog = {
  llmPolicy: { maskIdentifiers: boolean };
  tables: Record<string, {
    columns: Record<string, { privacy: { classification: PrivacyClass } }>;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeCatalog() {
  try {
    const path = join(dirname(getDatabasePath()), "dataset-catalog.json");
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")) as PrivacyCatalog
      : undefined;
  } catch {
    return undefined;
  }
}

function columnsByPrivacy(catalog: PrivacyCatalog, classes: PrivacyClass[]) {
  const allowed = new Set(classes);
  return Object.values(catalog.tables).flatMap(({ columns }) =>
    Object.entries(columns)
      .filter(([, column]) => allowed.has(column.privacy.classification))
      .map(([name]) => name),
  );
}

function mentions(question: string, columns: string[]) {
  return columns.some((column) => new RegExp(`\\b${column}\\b`, "i").test(question));
}

const refusal = "Privacy / riêng tư: cannot expose row-level identifiers with quasi-identifiers because that enables re-identification / định danh. I can provide a customer aggregate instead.";

export function privacyRefusalForQuestion(
  question: string,
  catalog: PrivacyCatalog | undefined = activeCatalog(),
) {
  if (!catalog?.llmPolicy.maskIdentifiers) return;
  const direct = columnsByPrivacy(catalog, ["identifier", "direct_identifier"]);
  const quasi = columnsByPrivacy(catalog, ["quasi_identifier"]);
  const rawRequest = /\b(?:list|identify|identity|re-identif|export)\b|danh tính|định danh|xuất\s+customer_id|liệt kê\s+customer_id/i;
  return mentions(question, direct) && mentions(question, quasi) && rawRequest.test(question)
    ? refusal
    : undefined;
}

export function privacyRefusalForSql(sql: string, catalog: PrivacyCatalog | undefined = activeCatalog()) {
  if (!catalog?.llmPolicy.maskIdentifiers) return;
  const sensitive = new Set(columnsByPrivacy(
    catalog,
    ["identifier", "direct_identifier", "quasi_identifier"],
  ).map((column) => column.toLowerCase()));
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: "postgresql" });
  } catch {
    return;
  }
  const statement = Array.isArray(ast) ? ast[0] : ast;
  if (!isRecord(statement) || !Array.isArray(statement.columns)) return;
  const exposesSensitive = statement.columns.some((item) => {
    if (!isRecord(item) || !isRecord(item.expr)) return false;
    if (item.expr.type === "star") return true;
    const column = item.expr.column;
    const name = typeof column === "string"
      ? column
      : isRecord(column) && isRecord(column.expr) && typeof column.expr.value === "string"
        ? column.expr.value
        : undefined;
    return item.expr.type === "column_ref" && Boolean(name && sensitive.has(name.toLowerCase()));
  });
  return exposesSensitive ? refusal : undefined;
}
