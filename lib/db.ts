import { constants, DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const activePath = process.env.ACTIVE_DATABASE_PATH ?? join("data", "active.db");
export const dbPath = isAbsolute(activePath)
  ? activePath
  : resolve(process.cwd(), activePath);

const legacyDbPath = join(process.cwd(), "data", "olist.sqlite");

export function getDatabasePath() {
  if (existsSync(dbPath)) return dbPath;
  // ponytail: legacy fallback keeps existing installs running; remove after active.db migration.
  if (!process.env.ACTIVE_DATABASE_PATH && existsSync(legacyDbPath)) return legacyDbPath;
  throw new Error("Active database not found. Install data/active.db or set ACTIVE_DATABASE_PATH.");
}

export function getDb() {
  const db = new DatabaseSync(getDatabasePath(), { readOnly: true });
  db.enableDefensive(true);
  const allowed = new Set([
    constants.SQLITE_SELECT,
    constants.SQLITE_READ,
    constants.SQLITE_FUNCTION,
    constants.SQLITE_RECURSIVE,
  ]);
  db.setAuthorizer((action, argument) =>
    allowed.has(action) ||
    (action === constants.SQLITE_PRAGMA && ["table_info", "foreign_key_list"].includes(argument ?? ""))
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY,
  );
  return db;
}
