import { generateSql, type SqlCorrection } from "./llmSql";
import { runReadOnlyQuery, type QueryResult } from "./queryRunner";

type Generator = (
  question: string,
  correction?: SqlCorrection,
) => Promise<string>;
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

  let sql = await generateTimed();
  let result: QueryResult;
  try {
    result = runTimed(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed.";
    if (/Database not found/i.test(message)) throw error;
    sql = await generateTimed({ sql, error: message });
    result = runTimed(sql);
  }

  return { result, sqlGenerationMs, queryMs };
}
