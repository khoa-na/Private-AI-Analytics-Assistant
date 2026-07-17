import { getDb, queryRows } from "./db";
import type { Schema } from "./analyticsTypes";

export async function getSchema(): Promise<Schema> {
  const db = await getDb();
  try {
    const rows = await queryRows(db, `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'main'
      ORDER BY table_name, ordinal_position
    `) as Array<{ table_name: string; column_name: string }>;
    return rows.reduce<Schema>((schema, row) => {
      (schema[row.table_name] ??= []).push(row.column_name);
      return schema;
    }, {});
  } finally {
    db.closeSync();
  }
}

export async function getSchemaText() {
  const db = await getDb();
  try {
    const rows = await queryRows(db, `
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'main'
      ORDER BY table_name, ordinal_position
    `) as Array<{ table_name: string; column_name: string; data_type: string }>;
    const constraints = await queryRows(db, `
      SELECT table_name, constraint_column_names
      FROM duckdb_constraints()
      WHERE schema_name = 'main' AND constraint_type = 'PRIMARY KEY'
    `) as Array<{ table_name: string; constraint_column_names: string[] }>;
    const primaryKeys = new Map(constraints.map(({ table_name, constraint_column_names }) => [
      table_name,
      new Set(constraint_column_names),
    ]));
    const tables = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!tables.has(row.table_name)) tables.set(row.table_name, []);
      tables.get(row.table_name)!.push(row);
    }
    return [...tables].map(([name, columns]) =>
      `${name}(${columns.map((column) =>
        `${column.column_name} ${column.data_type}${primaryKeys.get(name)?.has(column.column_name) ? " PRIMARY KEY" : ""}`
      ).join(", ")})`,
    ).join("\n");
  } finally {
    db.closeSync();
  }
}
