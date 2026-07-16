import { generateSql, type SqlCorrection } from "./llmSql";
import type { AnalysisBrief, IntentResponse, PlanReview } from "./queryPlan";
import { runReadOnlyQuery, type QueryResult } from "./queryRunner";
import { PipelineStageError } from "./pipelineError";
import { privacyRefusalForSql } from "./privacySafety";
import { assessResultQuality } from "./resultProfile";
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
  let brief: AnalysisBrief | undefined;
  let review: PlanReview | undefined;

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
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let generated: Awaited<ReturnType<Generator>>;
    try {
      generated = await generateTimed(correction);
    } catch (error) {
      if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
      throw error;
    }
    let sql: string;
    if (typeof generated === "string") {
      sql = generated;
    } else if (generated.intent === "query") {
      brief = generated.brief;
      review = generated.review;
      sql = generated.sql;
    } else {
      return { ...generated, sqlGenerationMs, queryMs };
    }
    const privacyRefusal = privacyRefusalForSql(sql);
    if (privacyRefusal) {
      return { intent: "refusal" as const, message: privacyRefusal, sqlGenerationMs, queryMs };
    }
    try {
      const result = runTimed(sql, attempt);
      const quality = brief
        ? assessResultQuality(result.columns, result.rows, result.truncated, brief)
        : { issues: [], caveats: [] };
      if (quality.issues.length) {
        throw new PipelineStageError("quality", quality.issues.join(" "), attempt);
      }
      return {
        intent: "query" as const,
        result,
        brief,
        ...(review ? { review } : {}),
        ...(sqlAttempts.length ? { sqlAttempts } : {}),
        quality,
        sqlGenerationMs,
        queryMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Query failed.";
      sqlAttempts.push({ attempt, sql, error: message });
      if (/Database not found/i.test(message) || attempt === 2) {
        if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
        throw error;
      }
      correction = {
        sql,
        error: message,
        attempt: attempt + 1,
        ...(brief ? { brief } : {}),
      };
    }
  }
  throw new Error("Query generation failed.");
}
