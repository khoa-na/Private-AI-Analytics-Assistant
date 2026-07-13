import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";

const root = process.cwd();
const dataDir = join(root, "data");
const dbPath = join(dataDir, "active.db");

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

const indexes = [
  "CREATE INDEX idx_orders_order_id ON orders(order_id)",
  "CREATE INDEX idx_orders_customer_id ON orders(customer_id)",
  "CREATE INDEX idx_order_items_order_id ON order_items(order_id)",
  "CREATE INDEX idx_order_items_product_id ON order_items(product_id)",
  "CREATE INDEX idx_order_reviews_order_id ON order_reviews(order_id)",
  "CREATE INDEX idx_order_payments_order_id ON order_payments(order_id)",
  "CREATE INDEX idx_products_product_id ON products(product_id)",
  "CREATE INDEX idx_category_translation_name ON category_translation(product_category_name)",
];

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function loadCsv(db: DatabaseSync, fileName: string, tableName: string) {
  const csvPath = join(dataDir, fileName);
  if (!existsSync(csvPath)) throw new Error(`Missing data/${fileName}`);

  const stream = createReadStream(csvPath).pipe(
    parse({ bom: true, columns: true, skip_empty_lines: true }),
  );

  let columns: string[] = [];
  let insert: StatementSync | undefined;
  let rowCount = 0;

  db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
  db.exec("BEGIN");

  try {
    for await (const row of stream) {
      if (!insert) {
        columns = Object.keys(row);
        const columnSql = columns
          .map((column) => `${quoteIdentifier(column)} TEXT`)
          .join(", ");
        const placeholders = columns.map(() => "?").join(", ");

        db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${columnSql})`);
        insert = db.prepare(
          `INSERT INTO ${quoteIdentifier(tableName)} VALUES (${placeholders})`,
        );
      }

      insert.run(...columns.map((column) => row[column] ?? null));
      rowCount += 1;
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log(`Loaded ${String(rowCount).padStart(8)} rows into ${tableName}`);
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(dbPath)) rmSync(dbPath);

  const db = new DatabaseSync(dbPath);
  for (const [fileName, tableName] of Object.entries(tables)) {
    await loadCsv(db, fileName, tableName);
  }

  db.exec("BEGIN");
  try {
    for (const index of indexes) db.exec(index);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.close();

  console.log(`Created ${indexes.length} indexes`);
  console.log(`\nDatabase created at ${dbPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
