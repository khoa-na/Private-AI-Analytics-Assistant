import { generateSql, type SqlCorrection } from "./llmSql";
import type { IntentResponse } from "./queryPlan";
import { runReadOnlyQuery, type QueryResult } from "./queryRunner";

type Generator = (
  question: string,
  correction?: SqlCorrection,
) => Promise<string | IntentResponse>;
type Runner = (sql: string) => QueryResult;

export async function generateAndRunQuery(
  question: string,
  generate: Generator = generateSql,
  run: Runner = runReadOnlyQuery,
) {
  let sqlGenerationMs = 0;
  let queryMs = 0;

  async function generateTimed(correction?: SqlCorrection) {
    const started = Date.now();
    try {
      return await generate(question, correction);
    } finally {
      sqlGenerationMs += Date.now() - started;
    }
  }

  function runTimed(sql: string) {
    const started = Date.now();
    try {
      return run(sql);
    } finally {
      queryMs += Date.now() - started;
    }
  }

  let generated = await generateTimed();
  if (typeof generated !== "string") {
    return { ...generated, sqlGenerationMs, queryMs };
  }
  let sql = generated;
  let result: QueryResult;
  try {
    result = runTimed(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed.";
    if (/Database not found/i.test(message)) throw error;
    generated = await generateTimed({ sql, error: message });
    if (typeof generated !== "string") {
      return { ...generated, sqlGenerationMs, queryMs };
    }
    sql = generated;
    result = runTimed(sql);
  }

  return { intent: "query" as const, result, sqlGenerationMs, queryMs };
}
