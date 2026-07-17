import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DatasetProfile } from "./datasetImport";
import { queryRows } from "./db";

const ARTIFACT_NAMES = [
  "dataset-profile.json",
  "dataset-catalog.json",
  "dataset.md",
  "dataset.runtime.md",
  "semantic.json",
] as const;
export const DATABASE_NAME = "database.duckdb";
export const BUNDLE_MANIFEST_NAME = "bundle-manifest.json";
export const REVIEW_REPORT_NAME = "review-report.json";
export const BUNDLE_STATES = ["draft", "approved", "rejected", "active"] as const;

type ArtifactName = typeof ARTIFACT_NAMES[number];
type ArtifactFingerprint = { bytes: number; sha256: string };
export type BundleState = typeof BUNDLE_STATES[number];
export type BundleManifest = {
  schema_version: 1;
  dataset: string;
  state: BundleState;
  created_at: string;
  sealed_at?: string;
  database: { bytes: number; mtime_ms: number; schema_sha256: string };
  artifacts: Record<ArtifactName, ArtifactFingerprint>;
  source: { kind: "directory" | "duckdb"; manifest_sha256?: string };
  generation: { generated_by: "ai" | "deterministic"; model?: string; prompt_version: 1 };
  review?: {
    decision: "approved" | "rejected";
    reviewed_at: string;
    reviewer: "ai" | "deterministic";
    model?: string;
    report: ArtifactFingerprint;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function fileFingerprint(path: string): ArtifactFingerprint {
  const content = readFileSync(path);
  return { bytes: content.byteLength, sha256: sha256(content) };
}

export async function schemaFingerprint(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath, { access_mode: "READ_ONLY" });
  const db = await instance.connect();
  try {
    const tables = await queryRows(db,
      "SELECT schema_name, table_name, sql FROM duckdb_tables() WHERE internal = false ORDER BY schema_name, table_name",
    );
    const indexes = await queryRows(db,
      "SELECT schema_name, table_name, index_name, sql FROM duckdb_indexes() ORDER BY schema_name, table_name, index_name",
    );
    const constraints = await queryRows(db,
      "SELECT schema_name, table_name, constraint_type, constraint_text FROM duckdb_constraints() ORDER BY schema_name, table_name, constraint_index",
    );
    return sha256(JSON.stringify({ tables, indexes, constraints }));
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}

async function databaseFingerprint(path: string) {
  const stat = statSync(path);
  return {
    bytes: stat.size,
    mtime_ms: Math.trunc(stat.mtimeMs),
    schema_sha256: await schemaFingerprint(path),
  };
}

function artifactFingerprints(directory: string) {
  return Object.fromEntries(ARTIFACT_NAMES.map((name) => [name, fileFingerprint(join(directory, name))])) as BundleManifest["artifacts"];
}

function atomicWrite(path: string, content: string) {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeManifest(directory: string, manifest: BundleManifest) {
  atomicWrite(join(directory, BUNDLE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function writeDatasetBundle(
  directory: string,
  files: Record<ArtifactName, string>,
  metadata: { dataset: string; sourcePath: string; generatedBy: "ai" | "deterministic"; model?: string },
) {
  const pending = ARTIFACT_NAMES.map((name) => ({
    target: join(directory, name),
    temporary: join(directory, `.${name}.tmp`),
    content: files[name],
  }));
  try {
    for (const file of pending) {
      rmSync(file.temporary, { force: true });
      writeFileSync(file.temporary, file.content);
    }
    for (const file of pending) renameSync(file.temporary, file.target);
  } finally {
    for (const file of pending) rmSync(file.temporary, { force: true });
  }

  const sourceManifest = statSync(metadata.sourcePath).isDirectory() ? join(metadata.sourcePath, "dataset.json") : undefined;
  const manifest: BundleManifest = {
    schema_version: 1,
    dataset: metadata.dataset,
    state: "draft",
    created_at: new Date().toISOString(),
    database: await databaseFingerprint(join(directory, DATABASE_NAME)),
    artifacts: artifactFingerprints(directory),
    source: {
      kind: sourceManifest ? "directory" : "duckdb",
      ...(sourceManifest && existsSync(sourceManifest) ? { manifest_sha256: fileFingerprint(sourceManifest).sha256 } : {}),
    },
    generation: {
      generated_by: metadata.generatedBy,
      ...(metadata.model ? { model: metadata.model } : {}),
      prompt_version: 1,
    },
  };
  writeManifest(directory, manifest);
  return manifest;
}

export function readBundleManifest(directory: string): BundleManifest {
  const path = join(directory, BUNDLE_MANIFEST_NAME);
  if (!existsSync(path)) throw new Error(`Missing staged artifact: ${path}. Re-run dataset import or refresh.`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) || value.schema_version !== 1 || typeof value.dataset !== "string" ||
    !BUNDLE_STATES.includes(value.state as BundleState) ||
    !isRecord(value.database) || !isRecord(value.artifacts) || !isRecord(value.source) || !isRecord(value.generation)
  ) throw new Error("Invalid bundle-manifest.json structure.");
  const state = value.state as BundleState;
  const review = value.review;
  const expectedDecision = state === "active" ? "approved" : state;
  if (state !== "draft" && (
    !isRecord(review) || review.decision !== expectedDecision || typeof review.reviewed_at !== "string" ||
    !["ai", "deterministic"].includes(String(review.reviewer)) || !isRecord(review.report)
  )) throw new Error(`Bundle state ${state} requires a valid review seal.`);
  return value as BundleManifest;
}

function sameFingerprint(
  left: ArtifactFingerprint | BundleManifest["database"],
  right: ArtifactFingerprint | BundleManifest["database"] | undefined,
) {
  return Boolean(right) && Object.keys(left).every((key) => left[key as keyof typeof left] === right?.[key as keyof typeof right]);
}

export async function validateStagedBundle(directory: string, expectedDataset: string) {
  const manifest = readBundleManifest(directory);
  if (manifest.dataset !== expectedDataset) {
    throw new Error(`Bundle dataset mismatch: expected ${expectedDataset}, found ${manifest.dataset}.`);
  }
  const databasePath = join(directory, DATABASE_NAME);
  if (!existsSync(databasePath) || !sameFingerprint(await databaseFingerprint(databasePath), manifest.database)) {
    throw new Error(`${DATABASE_NAME} no longer matches bundle-manifest.json; re-run dataset import or refresh.`);
  }
  for (const name of ARTIFACT_NAMES) {
    const path = join(directory, name);
    if (!existsSync(path)) throw new Error(`Missing staged artifact: ${path}`);
    if (!sameFingerprint(fileFingerprint(path), manifest.artifacts[name])) {
      throw new Error(`${name} no longer matches bundle-manifest.json; re-run dataset import or refresh.`);
    }
  }
  if (manifest.review) {
    const reportPath = join(directory, REVIEW_REPORT_NAME);
    if (!existsSync(reportPath) || !sameFingerprint(fileFingerprint(reportPath), manifest.review.report)) {
      throw new Error(`${REVIEW_REPORT_NAME} no longer matches bundle-manifest.json.`);
    }
  }
  const profile = JSON.parse(readFileSync(join(directory, "dataset-profile.json"), "utf8")) as DatasetProfile;
  if (profile.dataset !== expectedDataset || !Array.isArray(profile.tables)) {
    throw new Error("dataset-profile.json does not match the staged dataset.");
  }
  return { manifest, profile: { ...profile, databasePath } };
}

export async function quickCheckDatabase(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath, { access_mode: "READ_ONLY" });
  const db = await instance.connect();
  try {
    await queryRows(db, "SELECT COUNT(*) AS table_count FROM information_schema.tables");
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}

const TRANSITIONS: Record<BundleState, BundleState[]> = {
  draft: ["approved", "rejected"],
  approved: ["approved", "rejected", "active"],
  rejected: ["approved", "rejected"],
  active: [],
};

export function transitionBundleState(
  directory: string,
  expected: BundleState,
  next: BundleState,
  review?: { reviewer: "ai" | "deterministic"; model?: string; reviewedAt?: string },
) {
  const manifest = readBundleManifest(directory);
  if (manifest.state !== expected) throw new Error(`Bundle state mismatch: expected ${expected}, found ${manifest.state}.`);
  if (!TRANSITIONS[manifest.state].includes(next)) throw new Error(`Invalid bundle state transition: ${manifest.state} -> ${next}.`);
  const reviewDecision = next === "approved" || next === "rejected";
  if (reviewDecision && !review) throw new Error(`Bundle transition to ${next} requires review metadata.`);
  if (next === "active" && manifest.review?.decision !== "approved") {
    throw new Error("Only a review-sealed approved bundle can become active.");
  }
  const transitioned: BundleManifest = {
    ...manifest,
    state: next,
    ...(reviewDecision ? {
      artifacts: { ...manifest.artifacts, "semantic.json": fileFingerprint(join(directory, "semantic.json")) },
      review: {
        decision: next,
        reviewed_at: review?.reviewedAt ?? new Date().toISOString(),
        reviewer: review!.reviewer,
        ...(review?.model ? { model: review.model } : {}),
        report: fileFingerprint(join(directory, REVIEW_REPORT_NAME)),
      },
    } : {}),
    ...(next === "active" ? { sealed_at: new Date().toISOString() } : {}),
  };
  writeManifest(directory, transitioned);
  return transitioned;
}
