import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

function getGuidePaths() {
  const configured = process.env.ACTIVE_DATASET_GUIDE_PATHS;
  if (!configured) {
    const configuredDatabase = process.env.ACTIVE_DATABASE_PATH;
    const active = configuredDatabase
      ? dirname(isAbsolute(configuredDatabase) ? configuredDatabase : resolve(process.cwd(), configuredDatabase))
      : join(process.cwd(), "data", "active");
    if (existsSync(active)) {
      const runtime = join(active, "dataset.runtime.md");
      return [existsSync(runtime) ? runtime : join(active, "dataset.md"), join(active, "semantic.json")];
    }
    if (configuredDatabase) return [];
    return [join(process.cwd(), "data", "dataset.md"), join(process.cwd(), "data", "semantic.json")];
  }
  return configured.split(delimiter).filter(Boolean).map((path) =>
    isAbsolute(path) ? path : resolve(process.cwd(), path),
  );
}

export function getDatasetGuide() {
  const guide = getGuidePaths()
    .filter(existsSync)
    .map((path) => {
      const text = readFileSync(path, "utf8").trim();
      if (!path.toLowerCase().endsWith(".json")) return text;
      try {
        const value = JSON.parse(text) as Record<string, unknown>;
        if (value.schema_version !== 1) return text;
        const { relationship_candidates, measure_candidates, generation_error, ...confirmed } = value;
        void relationship_candidates;
        void measure_candidates;
        void generation_error;
        return JSON.stringify(confirmed);
      } catch {
        return text;
      }
    })
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(guide) > 12_000) {
    throw new Error("Active dataset guide is larger than 12 KB.");
  }
  return guide || "No dataset-specific semantics are installed. Use only the database schema and ask for clarification when a business measure is ambiguous.";
}

export function getSemanticClarification(question: string) {
  for (const path of getGuidePaths().filter((path) => path.toLowerCase().endsWith("semantic.json") && existsSync(path))) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const policy = value.analysis_policy as Record<string, unknown> | undefined;
      const rules = Array.isArray(policy?.clarification_rules) ? policy.clarification_rules : [];
      for (const rule of rules) {
        if (!rule || typeof rule !== "object") continue;
        const item = rule as Record<string, unknown>;
        const all = Array.isArray(item.all) ? item.all.filter((term): term is string => typeof term === "string") : [];
        const any = Array.isArray(item.any) ? item.any.filter((term): term is string => typeof term === "string") : [];
        const unless = Array.isArray(item.unless) ? item.unless.filter((term): term is string => typeof term === "string") : [];
        const includes = (term: string) => question.toLocaleLowerCase().includes(term.toLocaleLowerCase());
        if (typeof item.message === "string" && all.every(includes) && (!any.length || any.some(includes)) && !unless.some(includes)) {
          return item.message;
        }
      }
    } catch {
      continue;
    }
  }
}
