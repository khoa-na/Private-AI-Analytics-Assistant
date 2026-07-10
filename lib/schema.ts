import { getDb } from "./db";
import type { Schema } from "./analyticsTypes";

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function getSchema(): Schema {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];

  const schema: Schema = {};
  for (const { name } of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all() as { name: string }[];
    schema[name] = columns.map((column) => column.name);
  }

  db.close();
  return schema;
}

export function getSchemaText() {
  return Object.entries(getSchema())
    .map(([table, columns]) => `${table}(${columns.join(", ")})`)
    .join("\n");
}
