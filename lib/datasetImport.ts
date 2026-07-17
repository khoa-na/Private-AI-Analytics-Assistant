import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  copyFileSync,
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
import { queryRows } from "./db";
import { buildColumnEvidence, DEFAULT_LLM_POLICY, type LlmPolicy, type PrivacyClass, type SemanticType } from "./datasetEvidence";

type DatasetTable = {
  name: string;
  sources: string[];
  format: "csv" | "tsv" | "parquet";
  delimiter?: string;
  primaryKey?: string[];
  sourceColumn?: string;
  indexes?: string[][];
};
export type ClarificationRule = { all?: string[]; any?: string[]; unless?: string[]; message: string };
type DatasetManifest = {
  name?: string;
  analysisHints?: string[];
  clarificationRules?: ClarificationRule[];
  llmPolicy?: LlmPolicy;
  tables: DatasetTable[];
};

const PROFILE_SAMPLE_SIZE = 10_000;

export type DatasetProfile = {
  dataset: string;
  databasePath: string;
  analysisHints?: string[];
  clarificationRules?: ClarificationRule[];
  llmPolicy: LlmPolicy;
  tables: Array<{
    name: string;
    rowCount: number;
    profiledRows: number;
    profileMethod: "full" | "reservoir";
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

function quoteString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function datasetSlug(value: string) {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("Dataset name must contain letters or numbers.");
  return slug;
}

function tableName(file: string) {
  return basename(file, extname(file)).replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^\d/, "_$&").replace(/^_+|_+$/g, "");
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
  if (value.maxExampleLength !== undefined &&
    (!Number.isInteger(value.maxExampleLength) || Number(value.maxExampleLength) < 16 || Number(value.maxExampleLength) > 200)) {
    throw new Error("dataset.json llmPolicy.maxExampleLength must be an integer from 16 to 200.");
  }
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
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() ||
      !Array.isArray(item.sources) || !item.sources.length || !item.sources.every((source) => typeof source === "string" && source.trim()) ||
      !["csv", "tsv", "parquet"].includes(String(item.format)) ||
      (item.delimiter !== undefined && (typeof item.delimiter !== "string" || !item.delimiter)) ||
      (item.primaryKey !== undefined && (!Array.isArray(item.primaryKey) || !item.primaryKey.every((key) => typeof key === "string" && key))) ||
      (item.sourceColumn !== undefined && (typeof item.sourceColumn !== "string" || !item.sourceColumn)) ||
      (item.indexes !== undefined && (!Array.isArray(item.indexes) || !item.indexes.every((columns) =>
        Array.isArray(columns) && columns.length && columns.every((column) => typeof column === "string" && column))))) {
      throw new Error(`Invalid table at dataset.json tables[${index}].`);
    }
    return {
      name: item.name,
      sources: item.sources as string[],
      format: item.format as DatasetTable["format"],
      ...(item.delimiter ? { delimiter: item.delimiter } : {}),
      ...(item.primaryKey ? { primaryKey: item.primaryKey as string[] } : {}),
      ...(item.sourceColumn ? { sourceColumn: item.sourceColumn } : {}),
      ...(item.indexes ? { indexes: item.indexes as string[][] } : {}),
    };
  });
  if (new Set(tables.map(({ name }) => name)).size !== tables.length) throw new Error("dataset.json table names must be unique.");
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim())) {
    throw new Error("dataset.json name must be a non-empty string.");
  }
  if (value.analysisHints !== undefined &&
    (!Array.isArray(value.analysisHints) || !value.analysisHints.every((hint) => typeof hint === "string" && hint.trim()))) {
    throw new Error("dataset.json analysisHints must contain non-empty strings.");
  }
  const clarificationRules = value.clarificationRules === undefined ? undefined : (() => {
    if (!Array.isArray(value.clarificationRules)) throw new Error("dataset.json clarificationRules must be an array.");
    return value.clarificationRules.map((rule, index): ClarificationRule => {
      if (!isRecord(rule) || typeof rule.message !== "string" || !rule.message.trim()) {
        throw new Error(`Invalid clarification rule at dataset.json clarificationRules[${index}].`);
      }
      const readTerms = (field: "all" | "any" | "unless") => {
        const terms = rule[field];
        if (terms === undefined) return;
        if (!Array.isArray(terms) || !terms.length || !terms.every((term) => typeof term === "string" && term.trim())) {
          throw new Error(`clarificationRules[${index}].${field} must contain non-empty strings.`);
        }
        return terms as string[];
      };
      const all = readTerms("all");
      const any = readTerms("any");
      const unless = readTerms("unless");
      if (!all && !any) throw new Error(`clarificationRules[${index}] requires all or any terms.`);
      return { ...(all ? { all } : {}), ...(any ? { any } : {}), ...(unless ? { unless } : {}), message: rule.message.trim() };
    });
  })();
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(value.analysisHints ? { analysisHints: value.analysisHints as string[] } : {}),
    ...(clarificationRules ? { clarificationRules } : {}),
    ...(value.llmPolicy !== undefined ? { llmPolicy: readLlmPolicy(value.llmPolicy) } : {}),
    tables,
  };
}

function automaticTables(source: string, files: string[]): DatasetTable[] {
  const supported = files.filter((file) => [".csv", ".tsv", ".parquet"].includes(extname(file).toLowerCase()));
  if (!supported.length) throw new Error("The dataset directory contains no CSV, TSV, or Parquet files.");
  const names = supported.map(tableName);
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error("File names must produce unique table names; add dataset.json to define unions.");
  }
  return supported.map((file, index) => ({
    name: names[index],
    sources: [relative(source, file).replaceAll("\\", "/")],
    format: extname(file).toLowerCase().slice(1) as DatasetTable["format"],
  }));
}

function fileList(paths: string[]) {
  return `[${paths.map((path) => quoteString(resolve(path).replaceAll("\\", "/"))).join(", ")}]`;
}

async function importTable(db: DuckDBConnection, root: string, table: DatasetTable, paths: string[]) {
  const includeFilename = Boolean(table.sourceColumn);
  const scan = table.format === "parquet"
    ? `read_parquet(${fileList(paths)}, union_by_name = true, filename = ${includeFilename})`
    : `read_csv(${fileList(paths)}, header = true, delim = ${quoteString(table.delimiter ?? (table.format === "tsv" ? "\t" : ","))}, union_by_name = true, filename = ${includeFilename}, sample_size = 100000)`;
  const rootPrefix = `${resolve(root).replaceAll("\\", "/")}/`;
  const select = table.sourceColumn
    ? `* EXCLUDE(filename), replace(filename, ${quoteString(rootPrefix)}, '') AS ${quoteIdentifier(table.sourceColumn)}`
    : "*";
  await db.run(`CREATE TABLE ${quoteIdentifier(table.name)} AS SELECT ${select} FROM ${scan}`);

  const columns = new Set((await queryRows(db, `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'main' AND table_name = ${quoteString(table.name)}
  `) as Array<{ column_name: string }>).map(({ column_name }) => column_name));
  for (const key of table.primaryKey ?? []) {
    if (!columns.has(key)) throw new Error(`Primary key column not found in ${table.name}: ${key}`);
  }
  if (table.primaryKey?.length) {
    await db.run(`ALTER TABLE ${quoteIdentifier(table.name)} ADD PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(", ")})`);
  }
}

async function applyIndexes(db: DuckDBConnection, tables: DatasetTable[]) {
  for (const table of tables) {
    const columns = new Set((await queryRows(db, `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'main' AND table_name = ${quoteString(table.name)}
    `) as Array<{ column_name: string }>).map(({ column_name }) => column_name));
    for (const index of table.indexes ?? []) {
      for (const column of index) if (!columns.has(column)) throw new Error(`Index column not found in ${table.name}: ${column}`);
      const name = `idx:${table.name}:${index.join(",")}`;
      await db.run(`CREATE INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table.name)} (${index.map(quoteIdentifier).join(", ")})`);
    }
  }
}

async function buildDatabase(source: string, destination: string, manifest?: DatasetManifest) {
  const files = recursiveFiles(source).sort();
  const tables = manifest?.tables ?? automaticTables(source, files);
  const instance = await DuckDBInstance.create(destination, {
    threads: process.env.DUCKDB_IMPORT_THREADS ?? "8",
    memory_limit: process.env.DUCKDB_MEMORY_LIMIT ?? "8GB",
  });
  const db = await instance.connect();
  try {
    for (const table of tables) {
      const paths = [...new Set(table.sources.flatMap((pattern) => files.filter((file) =>
        matchesGlob(relative(source, file).replaceAll("\\", "/"), pattern.replaceAll("\\", "/")))))];
      if (!paths.length) throw new Error(`No files match sources for table ${table.name}.`);
      console.log(`Importing ${table.name}: ${paths.length} file(s)`);
      await importTable(db, source, table, paths);
    }
    await applyIndexes(db, tables);
    await db.run("ANALYZE");
    await db.run("CHECKPOINT");
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}

async function sampleTable(db: DuckDBConnection, table: string, rowCount: number) {
  const rows = await queryRows(db, rowCount <= PROFILE_SAMPLE_SIZE
    ? `SELECT * FROM ${quoteIdentifier(table)}`
    : `SELECT * FROM ${quoteIdentifier(table)} USING SAMPLE reservoir(${PROFILE_SAMPLE_SIZE} ROWS) REPEATABLE (42)`);
  return { rows, method: rowCount <= PROFILE_SAMPLE_SIZE ? "full" as const : "reservoir" as const };
}

export async function profileDatabase(
  databasePath: string,
  dataset: string,
  llmPolicy: LlmPolicy = DEFAULT_LLM_POLICY,
): Promise<DatasetProfile> {
  const instance = await DuckDBInstance.create(databasePath, { access_mode: "READ_ONLY", threads: "4" });
  const db = await instance.connect();
  try {
    const tableNames = (await queryRows(db, `
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `) as Array<{ table_name: string }>).map(({ table_name }) => table_name);
    if (!tableNames.length) throw new Error("The database contains no user tables.");

    const tables: DatasetProfile["tables"] = [];
    for (const name of tableNames) {
      const count = await queryRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`) as Array<{ count: number }>;
      const rowCount = Number(count[0].count);
      const { rows: sample, method: profileMethod } = await sampleTable(db, name, rowCount);
      const info = await queryRows(db, `
        SELECT column_name AS name, data_type AS type
        FROM information_schema.columns
        WHERE table_schema = 'main' AND table_name = ${quoteString(name)}
        ORDER BY ordinal_position
      `) as Array<{ name: string; type: string }>;
      const constraints = await queryRows(db, `
        SELECT constraint_column_names
        FROM duckdb_constraints()
        WHERE schema_name = 'main' AND table_name = ${quoteString(name)} AND constraint_type = 'PRIMARY KEY'
      `) as Array<{ constraint_column_names: string[] }>;
      const primaryKeys = new Set(constraints[0]?.constraint_column_names ?? []);
      const singleColumnPrimaryKey = primaryKeys.size === 1;
      const columns = info.map((column) => {
        const declaredPrimaryKey = singleColumnPrimaryKey && primaryKeys.has(column.name);
        return {
          name: column.name,
          type: column.type || "UNKNOWN",
          ...buildColumnEvidence({
            table: name,
            name: column.name,
            type: column.type || "UNKNOWN",
            values: sample.map((row) => row[column.name]),
            profiledRows: sample.length,
            rowCount,
            declaredPrimaryKey,
            policy: llmPolicy,
          }),
          declaredPrimaryKey,
        };
      });
      tables.push({ name, rowCount, profiledRows: sample.length, profileMethod, columns });
    }

    const relationshipCandidates: DatasetProfile["relationshipCandidates"] = [];
    for (const parent of tables) {
      const entityName = parent.name.toLowerCase().replace(/(?:_table)?s$/, "");
      for (const key of parent.columns.filter((column) => column.candidateKey)) {
        for (const child of tables.filter((table) => table.name !== parent.name)) {
          if (!child.columns.some((column) => column.name === key.name)) continue;
          if (!key.declaredPrimaryKey && key.name.toLowerCase() !== `${entityName}_id` && parent.rowCount >= child.rowCount) continue;
          const rows = await queryRows(db, `
            WITH sample AS (
              SELECT DISTINCT ${quoteIdentifier(key.name)} AS value
              FROM ${quoteIdentifier(child.name)}
              WHERE ${quoteIdentifier(key.name)} IS NOT NULL LIMIT 1000
            )
            SELECT COUNT(*) AS sampledValues, COUNT(parent.${quoteIdentifier(key.name)}) AS matchedValues
            FROM sample LEFT JOIN ${quoteIdentifier(parent.name)} AS parent
              ON parent.${quoteIdentifier(key.name)} = sample.value
          `) as Array<{ sampledValues: number; matchedValues: number }>;
          const sampledValues = Number(rows[0].sampledValues);
          const overlap = sampledValues ? Number(rows[0].matchedValues) / sampledValues : 0;
          if (overlap >= 0.8) relationshipCandidates.push({
            from: `${child.name}.${key.name}`,
            to: `${parent.name}.${key.name}`,
            sampledValues,
            overlap,
            status: "needs_review",
          });
        }
      }
    }
    return { dataset, databasePath, llmPolicy, tables, relationshipCandidates };
  } finally {
    db.closeSync();
    instance.closeSync();
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

export async function refreshDataset(
  sourcePath: string,
  stagingRoot = join(process.cwd(), "data", "staging"),
  requestedName?: string,
) {
  return stageDataset(sourcePath, stagingRoot, requestedName);
}

export async function stageDataset(
  sourcePath: string,
  stagingRoot = join(process.cwd(), "data", "staging"),
  requestedName?: string,
) {
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`Dataset source not found: ${source}`);
  const directorySource = statSync(source).isDirectory();
  const manifest = directorySource ? readManifest(source) : undefined;
  const name = datasetSlug(requestedName ?? manifest?.name ?? basename(source, extname(source)));
  mkdirSync(stagingRoot, { recursive: true });
  const directory = stagingDirectory(realpathSync(stagingRoot), name);
  const canonicalSource = realpathSync(source);
  if (pathsOverlap(canonicalSource, directory)) throw new Error("Dataset source and staging destination must not overlap.");
  const temporary = stagingDirectory(stagingRoot, `.${name}.next`);
  const previous = stagingDirectory(stagingRoot, `.${name}.previous`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  const temporaryDatabase = join(temporary, "database.duckdb");
  try {
    if (directorySource) await buildDatabase(source, temporaryDatabase, manifest);
    else if (extname(source).toLowerCase() === ".duckdb") copyFileSync(source, temporaryDatabase);
    else throw new Error("Dataset source must be a DuckDB file or a directory containing CSV, TSV, or Parquet files.");
    const profile = {
      ...await profileDatabase(temporaryDatabase, name, manifest?.llmPolicy ?? DEFAULT_LLM_POLICY),
      ...(manifest?.analysisHints ? { analysisHints: manifest.analysisHints } : {}),
      ...(manifest?.clarificationRules ? { clarificationRules: manifest.clarificationRules } : {}),
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
    profile.databasePath = join(directory, "database.duckdb");
    return { directory, profile };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
