import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const dbPath = join(process.cwd(), "data", "olist.sqlite");

export function getDb() {
  if (!existsSync(dbPath)) {
    throw new Error("Database not found. Run: npm run build-db");
  }

  return new DatabaseSync(dbPath, { readOnly: true });
}
