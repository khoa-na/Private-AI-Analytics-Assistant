import { generateSql, type SqlCorrection } from "./llmSql";
import type { IntentResponse } from "./queryPlan";
import { runReadOnlyQuery, type QueryResult } from "./queryRunner";
import { PipelineStageError } from "./pipelineError";
import { validateReadOnlySql } from "./sqlSafety";

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

  function runTimed(sql: string, attempt: number) {
    const started = Date.now();
    try {
      try {
        validateReadOnlySql(sql);
      } catch (error) {
        throw new PipelineStageError(
          "sql",
          error instanceof Error ? error.message : String(error),
          attempt,
        );
      }
      return run(sql);
    } catch (error) {
      throw error instanceof PipelineStageError
        ? error
        : new PipelineStageError(
            "execution",
            error instanceof Error ? error.message : String(error),
            attempt,
          );
    } finally {
      queryMs += Date.now() - started;
    }
  }

  const sqlAttempts: Array<{ attempt: number; sql: string; error: string }> = [];
  let correction: SqlCorrection | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let generated: Awaited<ReturnType<Generator>>;
    try {
      generated = await generateTimed(correction);
    } catch (error) {
      if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
      throw error;
    }
    if (typeof generated !== "string") {
      return { ...generated, sqlGenerationMs, queryMs };
    }
    try {
      const result = runTimed(generated, attempt);
      return { intent: "query" as const, result, sqlGenerationMs, queryMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Query failed.";
      sqlAttempts.push({ attempt, sql: generated, error: message });
      if (/Database not found/i.test(message) || attempt === 3) {
        if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
        throw error;
      }
      correction = { sql: generated, error: message, attempt: attempt + 1 };
    }
  }
  throw new Error("Query generation failed.");
}
