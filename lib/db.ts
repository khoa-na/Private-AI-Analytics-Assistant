import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export function getDatabasePath() {
  const activePath = process.env.ACTIVE_DATABASE_PATH ?? join("data", "active", "database.duckdb");
  const dbPath = isAbsolute(activePath) ? activePath : resolve(process.cwd(), activePath);
  if (existsSync(dbPath)) return dbPath;
  throw new Error("Active DuckDB database not found. Activate a staged dataset or set ACTIVE_DATABASE_PATH.");
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export async function getDb(): Promise<DuckDBConnection> {
  const threads = positiveInteger("DUCKDB_THREADS", 4);
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT ?? "8GB";
  const instance = await DuckDBInstance.fromCache(getDatabasePath(), {
    access_mode: "READ_ONLY",
    threads: String(threads),
    memory_limit: memoryLimit,
  });
  return instance.connect();
}

export async function queryRows(
  db: DuckDBConnection,
  sql: string,
  values?: unknown[],
): Promise<Array<Record<string, unknown>>> {
  return (await readQuery(db, sql, values)).rows;
}

export async function readQuery(db: DuckDBConnection, sql: string, values?: unknown[]) {
  const reader = await db.runAndReadAll(sql, values as never[] | undefined);
  const columns = reader.columnNames();
  const types = new Map(columns.map((column, index) => [column, String(reader.columnType(index))]));
  const rows = reader.getRowObjectsJS().map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value, types.get(key))]),
  ));
  return { columns, rows };
}

function normalizeValue(value: unknown, type?: string): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return type === "DATE" ? value.toISOString().slice(0, 10) : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }
  return value;
}
