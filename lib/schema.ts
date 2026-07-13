import { getDb } from "./db";
import type { Schema } from "./analyticsTypes";

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function getSchema(): Schema {
  const db = getDb();
  try {
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

    return schema;
  } finally {
    db.close();
  }
}

export function getSchemaText() {
  const db = getDb();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return tables.map(({ name }) => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
      }>;
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      const fields = columns.map((column) =>
        `${column.name} ${column.type || "UNKNOWN"}${column.pk ? " PRIMARY KEY" : ""}`,
      );
      const relationships = foreignKeys.map(
        (key) => `FOREIGN KEY ${key.from} REFERENCES ${key.table}(${key.to})`,
      );
      return `${name}(${[...fields, ...relationships].join(", ")})`;
    }).join("\n");
  } finally {
    db.close();
  }
}
