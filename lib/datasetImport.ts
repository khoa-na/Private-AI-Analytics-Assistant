import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { parse } from "csv-parse";
import { buildColumnEvidence, DEFAULT_LLM_POLICY, type LlmPolicy, type PrivacyClass, type SemanticType } from "./datasetEvidence";

type InferredType = "INTEGER" | "REAL" | "TEXT";
type DatasetTable = {
  name: string;
  sources: string[];
  format: "csv" | "tsv";
  delimiter?: string;
  primaryKey?: string[];
  sourceColumn?: string;
  indexes?: string[][];
};
type DatasetManifest = { name?: string; analysisHints?: string[]; llmPolicy?: LlmPolicy; tables: DatasetTable[] };

const PROFILE_SAMPLE_SIZE = 10_000;

export type DatasetProfile = {
  dataset: string;
  databasePath: string;
  analysisHints?: string[];
  llmPolicy: LlmPolicy;
  tables: Array<{
    name: string;
    rowCount: number;
    profiledRows: number;
    profileMethod: "full" | "systematic_rowid" | "head";
    columns: Array<{
      name: string;
      type: string;
      nullCount: number;
      nullRate: number;
      distinctCount: number;
      distinctRate: number;
      examples: string[];
      topValues: Array<{ value: string; count: number }>;
      semanticType: SemanticType;
      privacy: { classification: PrivacyClass; examplesRedacted: boolean };
      averageLength?: number;
      min?: number;
      max?: number;
      minValue?: string;
      maxValue?: string;
      declaredPrimaryKey: boolean;
      candidateKey: boolean;
    }>;
  }>;
  relationshipCandidates: Array<{
    from: string;
    to: string;
    sampledValues: number;
    overlap: number;
    status: "needs_review";
  }>;
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function datasetSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("Dataset name must contain letters or numbers.");
  return slug;
}

function tableName(file: string) {
  return basename(file, extname(file))
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^\d/, "_$&")
    .replace(/^_+|_+$/g, "");
}

function classify(value: string): InferredType | undefined {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (/^[+-]?(?:0|[1-9]\d*)$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) {
    return "INTEGER";
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) && Number.isFinite(Number(trimmed))) {
    return "REAL";
  }
  return "TEXT";
}

function mergeType(current: InferredType | undefined, next: InferredType | undefined) {
  if (!next || current === next) return current ?? next;
  if (!current) return next;
  return current === "TEXT" || next === "TEXT" ? "TEXT" : "REAL";
}

function delimitedRecords(path: string, delimiter: string) {
  return createReadStream(path).pipe(
    parse({
      bom: true,
      columns: (headers: string[]) => {
        if (headers.some((header) => !header.trim())) {
          throw new Error(`${basename(path)} contains an empty column header.`);
        }
        const normalized = headers.map((header) => header.toLowerCase());
        if (new Set(normalized).size !== normalized.length) {
          throw new Error(`${basename(path)} contains duplicate column headers.`);
        }
        return headers;
      },
      delimiter,
      skip_empty_lines: true,
      relax_column_count: false,
    }),
  );
}

function sameColumns(left: string[], right: string[]) {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

async function inspectDelimited(paths: string[], delimiter: string) {
  const types = new Map<string, InferredType>();
  let columns: string[] = [];
  const rowsPerFile = Math.max(1, Math.floor(PROFILE_SAMPLE_SIZE / paths.length));
  for (const path of paths) {
    let rows = 0;
    for await (const record of delimitedRecords(path, delimiter) as AsyncIterable<Record<string, string>>) {
      const currentColumns = Object.keys(record);
      if (!columns.length) columns = currentColumns;
      if (!sameColumns(columns, currentColumns)) {
        throw new Error(`${basename(path)} does not match the table schema.`);
      }
      for (const column of columns) {
        const next = classify(record[column] ?? "");
        if (next) types.set(column, mergeType(types.get(column), next) ?? next);
      }
      rows += 1;
      if (rows >= rowsPerFile) break;
    }
    if (!rows) throw new Error(`${basename(path)} has no data rows.`);
  }
  return { columns, types };
}

function convert(value: string | undefined, type: InferredType, context: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (type === "TEXT") return value ?? "";
  const actual = classify(trimmed);
  if (actual !== "INTEGER" && !(type === "REAL" && actual === "REAL")) {
    throw new Error(`${context} contains ${JSON.stringify(value)} which is incompatible with inferred type ${type}.`);
  }
  const number = Number(trimmed);
  if (!Number.isFinite(number)) throw new Error(`${context} contains a non-finite number.`);
  return number;
}

async function importTable(db: DatabaseSync, root: string, table: DatasetTable, paths: string[]) {
  const delimiter = table.delimiter ?? (table.format === "tsv" ? "\t" : ",");
  const { columns, types } = await inspectDelimited(paths, delimiter);
  if (table.sourceColumn && columns.includes(table.sourceColumn)) {
    throw new Error(`Source column already exists in ${table.name}: ${table.sourceColumn}`);
  }
  for (const key of table.primaryKey ?? []) {
    if (!columns.includes(key) && key !== table.sourceColumn) {
      throw new Error(`Primary key column not found in ${table.name}: ${key}`);
    }
  }
  const outputColumns = [...columns, ...(table.sourceColumn ? [table.sourceColumn] : [])];
  const definitions = columns
    .map((column) => `${quoteIdentifier(column)} ${types.get(column) ?? "TEXT"}`)
    .join(", ");
  const primaryKey = table.primaryKey?.length
    ? `, PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(", ")})`
    : "";
  const sourceDefinition = table.sourceColumn ? `, ${quoteIdentifier(table.sourceColumn)} TEXT` : "";
  db.exec(`CREATE TABLE ${quoteIdentifier(table.name)} (${definitions}${sourceDefinition}${primaryKey})`);
  const statement: StatementSync = db.prepare(
    `INSERT INTO ${quoteIdentifier(table.name)} (${outputColumns.map(quoteIdentifier).join(", ")}) VALUES (${outputColumns.map(() => "?").join(", ")})`,
  );
  for (const path of paths) {
    db.exec("BEGIN");
    try {
      let rowNumber = 1;
      for await (const record of delimitedRecords(path, delimiter) as AsyncIterable<Record<string, string>>) {
        rowNumber += 1;
        if (!sameColumns(columns, Object.keys(record))) {
          throw new Error(`${basename(path)} does not match the table schema.`);
        }
        for (const key of table.primaryKey ?? []) {
          if (key !== table.sourceColumn && !(record[key] ?? "").trim()) {
            throw new Error(`${basename(path)} row ${rowNumber} has a blank primary key column: ${key}`);
          }
        }
        const values = columns.map((column) => convert(
          record[column],
          types.get(column) ?? "TEXT",
          `${basename(path)} row ${rowNumber} column ${column}`,
        ));
        if (table.sourceColumn) values.push(relative(root, path).replaceAll("\\", "/"));
        statement.run(...values);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function recursiveFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(path) : [path];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLlmPolicy(value: unknown): LlmPolicy | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("dataset.json llmPolicy must be an object.");
  for (const key of ["sendExamples", "sendFreeTextExamples", "maskIdentifiers"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`dataset.json llmPolicy.${key} must be boolean.`);
  }
  if (
    value.maxExampleLength !== undefined &&
    (!Number.isInteger(value.maxExampleLength) || Number(value.maxExampleLength) < 16 || Number(value.maxExampleLength) > 200)
  ) throw new Error("dataset.json llmPolicy.maxExampleLength must be an integer from 16 to 200.");
  return {
    ...DEFAULT_LLM_POLICY,
    ...(value.sendExamples !== undefined ? { sendExamples: value.sendExamples as boolean } : {}),
    ...(value.sendFreeTextExamples !== undefined ? { sendFreeTextExamples: value.sendFreeTextExamples as boolean } : {}),
    ...(value.maskIdentifiers !== undefined ? { maskIdentifiers: value.maskIdentifiers as boolean } : {}),
    ...(value.maxExampleLength !== undefined ? { maxExampleLength: Number(value.maxExampleLength) } : {}),
  };
}

function readManifest(source: string): DatasetManifest | undefined {
  const path = join(source, "dataset.json");
  if (!existsSync(path)) return;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || !Array.isArray(value.tables) || !value.tables.length) {
    throw new Error("dataset.json must contain a non-empty tables array.");
  }
  const tables = value.tables.map((item, index): DatasetTable => {
    if (
      !isRecord(item) || typeof item.name !== "string" || !item.name.trim() ||
      !Array.isArray(item.sources) || !item.sources.length || !item.sources.every((source) => typeof source === "string" && source.trim()) ||
      (item.format !== "csv" && item.format !== "tsv") ||
      (item.delimiter !== undefined && (typeof item.delimiter !== "string" || !item.delimiter)) ||
      (item.primaryKey !== undefined && (!Array.isArray(item.primaryKey) || !item.primaryKey.every((key) => typeof key === "string" && key))) ||
      (item.sourceColumn !== undefined && (typeof item.sourceColumn !== "string" || !item.sourceColumn)) ||
      (item.indexes !== undefined && (!Array.isArray(item.indexes) || !item.indexes.every((index) =>
        Array.isArray(index) && index.length && index.every((column) => typeof column === "string" && column)
      )))
    ) throw new Error(`Invalid table at dataset.json tables[${index}].`);
    return {
      name: item.name,
      sources: item.sources as string[],
      format: item.format,
      ...(item.delimiter ? { delimiter: item.delimiter } : {}),
      ...(item.primaryKey ? { primaryKey: item.primaryKey as string[] } : {}),
      ...(item.sourceColumn ? { sourceColumn: item.sourceColumn } : {}),
      ...(item.indexes ? { indexes: item.indexes as string[][] } : {}),
    };
  });
  const names = tables.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new Error("dataset.json table names must be unique.");
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim())) {
    throw new Error("dataset.json name must be a non-empty string.");
  }
  if (value.analysisHints !== undefined && (!Array.isArray(value.analysisHints) || !value.analysisHints.every((hint) => typeof hint === "string" && hint.trim()))) {
    throw new Error("dataset.json analysisHints must contain non-empty strings.");
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(value.analysisHints ? { analysisHints: value.analysisHints as string[] } : {}),
    ...(value.llmPolicy !== undefined ? { llmPolicy: readLlmPolicy(value.llmPolicy) } : {}),
    tables,
  };
}

function automaticTables(source: string, files: string[]): DatasetTable[] {
  const supported = files.filter((file) => [".csv", ".tsv"].includes(extname(file).toLowerCase()));
  if (!supported.length) throw new Error("The dataset directory contains no CSV or TSV files.");
  const names = supported.map(tableName);
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error("File names must produce unique table names; add dataset.json to define unions.");
  }
  return supported.map((file, index) => ({
    name: names[index],
    sources: [relative(source, file).replaceAll("\\", "/")],
    format: extname(file).toLowerCase() === ".tsv" ? "tsv" : "csv",
  }));
}

function applyIndexes(db: DatabaseSync, tables: DatasetTable[]) {
  for (const table of tables) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.size) throw new Error(`Index table not found: ${table.name}`);
    const desired = new Set((table.indexes ?? []).map((index) => `idx:${table.name}:${index.join(",")}`));
    const managed = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table.name) as Array<{ name: string }>)
      .map(({ name }) => name)
      .filter((name) => name.startsWith(`idx:${table.name}:`));
    for (const name of managed) {
      if (!desired.has(name)) db.exec(`DROP INDEX ${quoteIdentifier(name)}`);
    }
    for (const index of table.indexes ?? []) {
      for (const column of index) {
        if (!columns.has(column)) throw new Error(`Index column not found in ${table.name}: ${column}`);
      }
      const name = `idx:${table.name}:${index.join(",")}`;
      console.log(`Creating index ${table.name}(${index.join(", ")})`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${quoteIdentifier(table.name)} (${index.map(quoteIdentifier).join(", ")})`);
    }
  }
}

async function buildDelimitedDatabase(source: string, destination: string, manifest?: DatasetManifest) {
  const files = recursiveFiles(source).sort();
  const tables = manifest?.tables ?? automaticTables(source, files);
  const db = new DatabaseSync(destination);
  try {
    db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA locking_mode = EXCLUSIVE");
    for (const table of tables) {
      const paths = [...new Set(table.sources.flatMap((pattern) => files.filter((file) =>
        matchesGlob(relative(source, file).replaceAll("\\", "/"), pattern.replaceAll("\\", "/")),
      )))];
      if (!paths.length) throw new Error(`No files match sources for table ${table.name}.`);
      console.log(`Importing ${table.name}: ${paths.length} file(s)`);
      await importTable(db, source, table, paths);
    }
    applyIndexes(db, tables);
    db.exec("ANALYZE");
  } finally {
    db.close();
  }
}

function sampleTable(db: DatabaseSync, quotedTable: string, rowCount: number) {
  if (rowCount <= PROFILE_SAMPLE_SIZE) {
    return {
      rows: db.prepare(`SELECT * FROM ${quotedTable}`).all() as Array<Record<string, unknown>>,
      method: "full" as const,
    };
  }
  try {
    const range = db.prepare(`SELECT MIN(rowid) AS min, MAX(rowid) AS max FROM ${quotedTable}`).get() as { min?: number; max?: number };
    if (range.min === undefined || range.max === undefined) throw new Error("No rowid range.");
    const rows = db.prepare(`
      WITH RECURSIVE positions(i) AS (
        SELECT 0
        UNION ALL
        SELECT i + 1 FROM positions WHERE i + 1 < ${PROFILE_SAMPLE_SIZE}
      )
      SELECT source.*
      FROM positions
      JOIN ${quotedTable} AS source
        ON source.rowid = CAST(${range.min} + ((${range.max} - ${range.min}) * positions.i / ${PROFILE_SAMPLE_SIZE - 1}) AS INTEGER)
      ORDER BY positions.i
    `).all() as Array<Record<string, unknown>>;
    if (rows.length === PROFILE_SAMPLE_SIZE) return { rows, method: "systematic_rowid" as const };
  } catch {
    // WITHOUT ROWID tables fall back to a bounded head sample.
  }
  return {
    rows: db.prepare(`SELECT * FROM ${quotedTable} LIMIT ?`).all(PROFILE_SAMPLE_SIZE) as Array<Record<string, unknown>>,
    method: "head" as const,
  };
}

export function profileDatabase(databasePath: string, dataset: string, llmPolicy: LlmPolicy = DEFAULT_LLM_POLICY): DatasetProfile {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    if (!tableNames.length) throw new Error("The database contains no user tables.");

    const tables = tableNames.map((name) => {
      const quotedTable = quoteIdentifier(name);
      const rowCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable}`).get() as { count: number }).count);
      const { rows: sample, method: profileMethod } = sampleTable(db, quotedTable, rowCount);
      const profiledRows = sample.length;
      const info = db.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ name: string; type: string; pk: number }>;
      const singleColumnPrimaryKey = info.filter(({ pk }) => pk > 0).length === 1;
      const columns = info.map((column) => {
        const values = sample.map((row) => row[column.name]);
        const declaredPrimaryKey = singleColumnPrimaryKey && Boolean(column.pk);
        return {
          name: column.name,
          type: column.type || "UNKNOWN",
          ...buildColumnEvidence({
            table: name,
            name: column.name,
            type: column.type || "UNKNOWN",
            values,
            profiledRows,
            rowCount,
            declaredPrimaryKey,
            policy: llmPolicy,
          }),
          declaredPrimaryKey,
        };
      });
      return { name, rowCount, profiledRows, profileMethod, columns };
    });

    const relationshipCandidates: DatasetProfile["relationshipCandidates"] = [];
    for (const parent of tables) {
      const entityName = parent.name.toLowerCase().replace(/(?:_table)?s$/, "");
      for (const key of parent.columns.filter((column) => column.candidateKey)) {
        for (const child of tables.filter((table) => table.name !== parent.name)) {
          if (!child.columns.some((column) => column.name === key.name)) continue;
          if (
            !key.declaredPrimaryKey &&
            key.name.toLowerCase() !== `${entityName}_id` &&
            parent.rowCount >= child.rowCount
          ) continue;
          const parentTable = quoteIdentifier(parent.name);
          const childTable = quoteIdentifier(child.name);
          const column = quoteIdentifier(key.name);
          const match = db.prepare(`
            WITH sample(value) AS (
              SELECT DISTINCT ${column} FROM ${childTable} WHERE ${column} IS NOT NULL LIMIT 1000
            )
            SELECT COUNT(*) AS sampledValues,
              SUM(EXISTS(SELECT 1 FROM ${parentTable} WHERE ${parentTable}.${column} = sample.value)) AS matchedValues
            FROM sample
          `).get() as { sampledValues: number; matchedValues: number | null };
          const sampledValues = Number(match.sampledValues);
          const overlap = sampledValues ? Number(match.matchedValues ?? 0) / sampledValues : 0;
          if (overlap >= 0.8) {
            relationshipCandidates.push({
              from: `${child.name}.${key.name}`,
              to: `${parent.name}.${key.name}`,
              sampledValues,
              overlap,
              status: "needs_review",
            });
          }
        }
      }
    }

    return { dataset, databasePath, llmPolicy, tables, relationshipCandidates };
  } finally {
    db.close();
  }
}

function stagingDirectory(rootPath: string, name: string) {
  const root = resolve(rootPath);
  const directory = resolve(root, name);
  const fromRoot = relative(root, directory);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Invalid staging path.");
  return directory;
}

function pathsOverlap(left: string, right: string) {
  const contains = (parent: string, child: string) => {
    const fromParent = relative(parent, child);
    return !fromParent || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
  };
  return contains(left, right) || contains(right, left);
}

async function backupSqliteDatabase(source: string, destination: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  const copied = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = copied.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!result || !Object.values(result).includes("ok")) {
      throw new Error("SQLite backup failed PRAGMA quick_check.");
    }
  } finally {
    copied.close();
  }
}

export function refreshDataset(sourcePath: string, stagingRoot = join(process.cwd(), "data", "staging"), requestedName?: string) {
  const source = resolve(sourcePath);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error("Refresh source must be a dataset directory.");
  }
  const manifest = readManifest(source);
  if (!manifest) throw new Error("Refresh requires dataset.json in the source directory.");
  const name = datasetSlug(requestedName ?? manifest.name ?? basename(source));
  const directory = stagingDirectory(stagingRoot, name);
  const databasePath = join(directory, "database.sqlite");
  if (!existsSync(databasePath)) throw new Error(`Staged database not found: ${databasePath}`);
  const db = new DatabaseSync(databasePath);
  try {
    applyIndexes(db, manifest.tables);
  } finally {
    db.close();
  }
  return {
    directory,
    profile: {
      ...profileDatabase(databasePath, name, manifest.llmPolicy ?? DEFAULT_LLM_POLICY),
      analysisHints: manifest.analysisHints,
    },
  };
}

export async function stageDataset(sourcePath: string, stagingRoot = join(process.cwd(), "data", "staging"), requestedName?: string) {
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`Dataset source not found: ${source}`);
  const directorySource = statSync(source).isDirectory();
  const manifest = directorySource ? readManifest(source) : undefined;
  const name = datasetSlug(requestedName ?? manifest?.name ?? basename(source, extname(source)));
  mkdirSync(stagingRoot, { recursive: true });
  const directory = stagingDirectory(realpathSync(stagingRoot), name);
  const canonicalSource = realpathSync(source);
  if (pathsOverlap(canonicalSource, directory)) {
    throw new Error("Dataset source and staging destination must not overlap.");
  }
  const temporary = stagingDirectory(stagingRoot, `.${name}.next`);
  const previous = stagingDirectory(stagingRoot, `.${name}.previous`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  const temporaryDatabase = join(temporary, "database.sqlite");
  try {
    if (directorySource) {
      await buildDelimitedDatabase(source, temporaryDatabase, manifest);
    } else if ([".db", ".sqlite", ".sqlite3"].includes(extname(source).toLowerCase())) {
      await backupSqliteDatabase(source, temporaryDatabase);
    } else {
      throw new Error("Dataset source must be a SQLite file or a directory containing CSV/TSV files.");
    }
    const profile = {
      ...profileDatabase(temporaryDatabase, name, manifest?.llmPolicy ?? DEFAULT_LLM_POLICY),
      ...(manifest?.analysisHints ? { analysisHints: manifest.analysisHints } : {}),
    };
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(directory)) renameSync(directory, previous);
    try {
      renameSync(temporary, directory);
    } catch (error) {
      if (existsSync(previous) && !existsSync(directory)) renameSync(previous, directory);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    profile.databasePath = join(directory, "database.sqlite");
    return {
      directory,
      profile,
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
