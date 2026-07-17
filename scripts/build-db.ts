import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const olistDir = join(process.cwd(), "data", "olist");
const csvDir = join(olistDir, "raw");
const dbPath = join(olistDir, "database.duckdb");
const tables: Record<string, string> = {
  "olist_customers_dataset.csv": "customers",
  "olist_geolocation_dataset.csv": "geolocation",
  "olist_order_items_dataset.csv": "order_items",
  "olist_order_payments_dataset.csv": "order_payments",
  "olist_order_reviews_dataset.csv": "order_reviews",
  "olist_orders_dataset.csv": "orders",
  "olist_products_dataset.csv": "products",
  "olist_sellers_dataset.csv": "sellers",
  "product_category_name_translation.csv": "category_translation",
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

mkdirSync(olistDir, { recursive: true });
rmSync(dbPath, { force: true });
const instance = await DuckDBInstance.create(dbPath);
const db = await instance.connect();
try {
  for (const [file, table] of Object.entries(tables)) {
    const path = resolve(csvDir, file);
    if (!existsSync(path)) throw new Error(`Missing data/olist/raw/${file}`);
    await db.run(`CREATE TABLE ${quoteIdentifier(table)} AS SELECT * FROM read_csv(${quoteString(path.replaceAll("\\", "/"))}, header = true)`);
    const result = await db.runAndReadAll(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
    console.log(`Loaded ${String(result.getRowObjectsJson()[0].count).padStart(8)} rows into ${table}`);
  }
  await db.run("ANALYZE");
  await db.run("CHECKPOINT");
} finally {
  db.closeSync();
  instance.closeSync();
}

console.log(`Database created at ${dbPath}`);
