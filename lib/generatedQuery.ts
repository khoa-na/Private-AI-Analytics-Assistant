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
type Runner = (sql: string) => QueryResult | Promise<QueryResult>;

export function sqlContractIssues(question: string, sql: string) {
  const issues: string[] = [];
  if (/\bround\s*\(/i.test(sql) && !/\b(?:round|decimal|precision)\b|làm tròn|chữ số/i.test(question)) {
    issues.push("Preserve full numeric precision; rounding was not requested.");
  }
  if (/\b(?:change|increase|decrease|growth|mom)\b|thay đổi|tăng|giảm/i.test(question) &&
    /\//.test(sql) && !/%|\b(?:rate|ratio|percent|percentage|share)\b|tỷ lệ|tỷ trọng|phần trăm/i.test(question)) {
    issues.push("The question requests an absolute change, not a rate or percentage.");
  }
  const invalidAliases = [...sql.matchAll(/\bAS\s+invalid_\w+/gi)];
  const invalidExpressionIncludesNull = invalidAliases.some(({ index = 0 }) => {
    if (invalidAliases.length === 1 && !sql.slice(0, index).includes(",")) return /(?<!\bNOT\s)\bIS\s+NULL\b/i.test(sql);
    let depth = 0;
    let expressionStart = 0;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (sql[cursor] === ")") depth++;
      else if (sql[cursor] === "(" && depth > 0) depth--;
      else if (sql[cursor] === "," && depth === 0) {
        expressionStart = cursor + 1;
        break;
      }
    }
    const expression = sql.slice(expressionStart, index);
    return /(?<!\bNOT\s)\bIS\s+NULL\b/i.test(expression);
  });
  if (invalidExpressionIncludesNull &&
    !/(?:count|treat|include).*null.*invalid|null.*(?:counts?|treated?|included?).*invalid|null.*không hợp lệ/i.test(question)) {
    issues.push("Do not count null values as invalid-domain values unless explicitly requested.");
  }
  if (/\b(?:band|bucket)\b|phân nhóm/i.test(question) && /\bCASE\b[\s\S]*?\bELSE\b/i.test(sql) &&
    !/\bIS\s+NULL\b/i.test(sql) && !/exclude.*(?:null|missing)|loại.*(?:null|thiếu)/i.test(question)) {
    issues.push("Bucket null source values explicitly; do not let them fall into a numeric ELSE bucket.");
  }
  if (/sentinel/i.test(question) && /=\s*-1(?:\s+AND[\s\S]*?=\s*-1){2,}/i.test(sql) &&
    !/all.*simultaneously|every.*simultaneously|tất cả.*đồng thời/i.test(question)) {
    issues.push("A row with a sentinel in any audited field must qualify; do not require every field simultaneously.");
  }
  return issues;
}

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

  async function runTimed(sql: string, attempt: number) {
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
      return await run(sql);
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
      const contractIssues = sqlContractIssues(question, sql);
      if (contractIssues.length) throw new PipelineStageError("quality", contractIssues.join(" "), attempt);
      const result = await runTimed(sql, attempt);
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
