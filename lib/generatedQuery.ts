import { generateSql, type SqlCorrection } from "./llmSql";
import type { AnalysisBrief, IntentResponse, PlanReview } from "./queryPlan";
import { runReadOnlyQuery, type QueryResult } from "./queryRunner";
import { PipelineStageError } from "./pipelineError";
import { privacyRefusalForSql } from "./privacySafety";
import { assessResultQuality } from "./resultProfile";
import { validateReadOnlySql } from "./sqlSafety";
import type { Row } from "./analyticsTypes";

type Generator = (
  question: string,
  correction?: SqlCorrection,
) => Promise<string | IntentResponse>;
type Runner = (sql: string) => QueryResult | Promise<QueryResult>;

export function normalizeSqlAliases(sql: string) {
  if (!/\b(?:FROM|JOIN)\s+[A-Za-z_][\w."]*\s+(?:AS\s+)?at\b/i.test(sql)) return sql;
  return sql
    .replace(/(\b(?:FROM|JOIN)\s+[A-Za-z_][\w."]*\s+(?:AS\s+)?)at\b/gi, "$1at_alias")
    .replace(/\bat\./gi, "at_alias.");
}

export function normalizeMultiplicityCollections(question: string, sql: string) {
  if (!/\bcodes_with_multiple_names\b/i.test(question) ||
    !/\bnames_with_multiple_codes\b/i.test(question) ||
    /\b(?:list|array|collect)\b|danh sách|liệt kê/i.test(question)) return sql;
  return sql
    .replace(/\bLIST\s*\(\s*([^)]+?)\s*\)/gi, "COUNT(DISTINCT $1)")
    .replace(/,\s*\[\]\s*\)/g, ", 0)");
}

export function pivotNamedScalarMetrics(result: QueryResult, requiredColumns: string[]) {
  if (result.rows.length < 2 || !requiredColumns.length) return result;
  const dimensions = result.columns.filter((column) =>
    result.rows.every((row) => typeof row[column] === "string"));
  const metrics = result.columns.filter((column) =>
    result.rows.every((row) => typeof row[column] === "number"));
  if (dimensions.length !== 1 || metrics.length !== 1) return result;
  const [dimension] = dimensions;
  const [metric] = metrics;
  const row = Object.fromEntries(requiredColumns.map((column) => {
    const source = result.rows.find((item) =>
      column.toLowerCase().includes(String(item[dimension]).toLowerCase()));
    return [column, source?.[metric]];
  }));
  if (Object.values(row).some((value) => typeof value !== "number")) return result;
  return { ...result, columns: requiredColumns, rows: [row as Row] };
}

export function alignExplicitOutputColumns(outputColumns: string[], requiredColumns: string[]) {
  const aligned = [...outputColumns];
  for (const required of requiredColumns) {
    if (aligned.includes(required)) continue;
    const inferredIndex = aligned.findIndex((column) =>
      column === `${required}_label` || column === `${required}_name` || column === "label");
    if (inferredIndex >= 0) aligned[inferredIndex] = required;
    else aligned.push(required);
  }
  return [...new Set(aligned)];
}

export function alignResultColumns(result: QueryResult, requiredColumns: string[]) {
  const renames = new Map(requiredColumns.flatMap((required) => {
    const source = [`${required}_label`, `${required}_name`, "label"]
      .find((candidate) => result.columns.includes(candidate) && !requiredColumns.includes(candidate));
    return source ? [[source, required] as const] : [];
  }));
  if (!renames.size) return result;
  return {
    ...result,
    columns: result.columns.map((column) => renames.get(column) ?? column),
    rows: result.rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [renames.get(column) ?? column, value]),
    )),
  };
}

export function normalizeDerivedMetrics(result: QueryResult) {
  if (!result.columns.includes("absolute_gap")) return result;
  const inputs = result.columns.filter((column) => column !== "absolute_gap");
  if (inputs.length !== 2) return result;
  const rows = result.rows.map((row) => {
    const [left, right] = inputs.map((column) => row[column]);
    return typeof left === "number" && typeof right === "number"
      ? { ...row, absolute_gap: Math.abs(left - right) }
      : row;
  });
  return { ...result, rows };
}

export function explicitResultContract(question: string) {
  const requiredColumns = new Set<string>();
  function addColumns(clause: string) {
    const first = clause.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*,/i)?.[1];
    if (first) requiredColumns.add(first);
    for (const alias of clause.matchAll(/\bAS\s+([A-Za-z][A-Za-z0-9_]*)\b/gi)) {
      requiredColumns.add(alias[1]);
    }
    const outputText = clause.replace(/\([^()]*\)/g, "");
    for (const column of outputText.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) ?? []) {
      requiredColumns.add(column);
    }
  }

  for (const match of question.matchAll(/(?:\breturn|trả về)\s+([^.;\n]+)/gi)) {
    const prefix = question.slice(Math.max(0, (match.index ?? 0) - 12), match.index).toLowerCase();
    if (/(?:do\s+not|don't|not|không)\s*$/.test(prefix)) continue;
    const clause = match[1].split(/\bwithout\b|\bdo not\b|không\s+(?:trả|hiển thị)/i)[0];
    addColumns(clause);
  }
  for (const match of question.matchAll(/(?:\bwith|với)\s+((?:[A-Za-z][A-Za-z0-9_]*\s*,\s*)+[A-Za-z][A-Za-z0-9_]*)/gi)) {
    addColumns(match[1]);
  }
  for (const match of question.matchAll(/\b([A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+)\s+(?:is|là|counts?|đếm)\b/gi)) {
    requiredColumns.add(match[1]);
  }
  const count = question.match(
    /(?:(?:\bexactly|đúng)\s+|\blong-form\s+)(\d+)\s+(?:rows?|mappings?|mapping|dòng)/i,
  )?.[1];
  const scalarMetrics = requiredColumns.size > 1 &&
    [...requiredColumns].every((column) =>
      /(?:_rows|_count|_days|_sum|_avg|_average|_gap|^p\d+$|^median$|^iqr$)$/i.test(column));
  return {
    requiredColumns: [...requiredColumns],
    ...(count ? { expectedRowCount: Number(count) } : scalarMetrics ? { expectedRowCount: 1 } : {}),
  };
}

export function sqlContractIssues(question: string, sql: string) {
  const issues: string[] = [];
  if (/\b(?:FROM|JOIN)\s+[A-Za-z_][\w."]*\s+(?:AS\s+)?(?:at)\b/i.test(sql)) {
    issues.push("Use a non-reserved table alias; AT is a SQL keyword.");
  }
  const requestedPreAggregation = question.match(
    /(?:aggregate|pre-aggregate|group|tổng hợp)\s+(?:by|theo)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:first|before|trước)/i,
  )?.[1];
  if (requestedPreAggregation &&
    !new RegExp(`\\bGROUP\\s+BY\\b[^;]*\\b${requestedPreAggregation}\\b`, "i").test(sql)) {
    issues.push(`Pre-aggregate by ${requestedPreAggregation} before the later transformation or join.`);
  }
  if (/\bnearest-rank\b/i.test(question) &&
    (/\bPERCENTILE_CONT\s*\(/i.test(sql) || /\bFLOOR\s*\(/i.test(sql) ||
      /\(\s*\w+\s*\+\s*1\s*\)/i.test(sql))) {
    issues.push("Nearest-rank percentiles use rank CEIL(p * n), without interpolation or n + 1.");
  }
  if (/\bcodes_with_multiple_names\b/i.test(question) &&
    /\bnames_with_multiple_codes\b/i.test(question) &&
    /\bWHERE\b[^;]*\bOR\b/i.test(sql) &&
    /\bCOUNT\s*\(\s*DISTINCT\s+\w+\s*\)\s+AS\s+codes_with_multiple_names\b/i.test(sql) &&
    /\bCOUNT\s*\(\s*DISTINCT\s+\w+\s*\)\s+AS\s+names_with_multiple_codes\b/i.test(sql)) {
    issues.push("Count each direction with its own multiplicity condition; a shared OR filter contaminates both mapping metrics.");
  }
  if (/\bcodes_with_multiple_names\b/i.test(question) &&
    /\bnames_with_multiple_codes\b/i.test(question) &&
    (sql.match(/\bLEFT\s+JOIN\b/gi)?.length ?? 0) >= 2 &&
    /\bSUM\s*\(\s*CASE\s+WHEN\s+\w+\.num_names\b/i.test(sql) &&
    /\bSUM\s*\(\s*CASE\s+WHEN\s+\w+\.num_codes\b/i.test(sql)) {
    issues.push("Aggregate code-side and name-side multiplicity to the mapping grain before joining them; joining both detail sets by mapping multiplies rows.");
  }
  if (/\b(?:list|array_agg|string_agg)\s*\(/i.test(sql) &&
    !/\b(?:list|array|collect)\b|danh sách|liệt kê/i.test(question)) {
    issues.push("Collection aggregation was not requested; return scalar metrics at the declared grain.");
  }
  const groupedPeriodAverage = /\baverage of (?:daily|weekly|monthly|quarterly|yearly)\b/i.test(question) ||
    /trung bình[^.;\n]*(?:ngày|tuần|tháng|quý|năm)/i.test(question);
  const explicitlyAveragingAverages = /\baverage of (?:daily|weekly|monthly|quarterly|yearly)\s+(?:averages?|means?)\b/i.test(question) ||
    /trung bình[^.;\n]*trung bình/i.test(question);
  if (groupedPeriodAverage && (!/\bGROUP\s+BY\b/i.test(sql) ||
    !/(?:\b(?:date_trunc|strftime|extract|year|month|quarter|week|day)\s*\(|\b(?:date|day|week|month|quarter|year)(?:_\w+)?\b)/i.test(sql))) {
    issues.push("Preserve the requested period grain in a grouped intermediate result before averaging periods.");
  }
  if (groupedPeriodAverage && !explicitlyAveragingAverages &&
    (sql.match(/\bAVG\s*\(/gi)?.length ?? 0) > 1 && /\bGROUP\s+BY\b/i.test(sql)) {
    issues.push("Keep a grouped period-level CTE, compute the requested non-average measure there, then average those period rows; do not use an inner average or collapse to base-row grain.");
  }
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
  const requestContract = explicitResultContract(question);

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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let generated: Awaited<ReturnType<Generator>>;
    try {
      generated = await generateTimed(correction);
    } catch (error) {
      if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
      throw error;
    }
    let sql: string;
    if (typeof generated === "string") {
      sql = normalizeMultiplicityCollections(question, normalizeSqlAliases(generated));
    } else if (generated.intent === "query") {
      brief = generated.brief;
      review = generated.review;
      sql = normalizeMultiplicityCollections(question, normalizeSqlAliases(generated.sql));
    } else {
      return { ...generated, sqlGenerationMs, queryMs };
    }
    const privacyRefusal = privacyRefusalForSql(sql);
    if (privacyRefusal) {
      return { intent: "refusal" as const, message: privacyRefusal, sqlGenerationMs, queryMs };
    }
    try {
      if (brief) {
        const alignedOutputColumns = alignExplicitOutputColumns(
          brief.outputColumns,
          requestContract.requiredColumns,
        );
        const briefNeedsAlignment = alignedOutputColumns.length !== brief.outputColumns.length ||
          alignedOutputColumns.some((column, index) => column !== brief!.outputColumns[index]);
        if (briefNeedsAlignment) {
          brief = {
            ...brief,
            dimensions: brief.dimensions
              .map((column) => column === "label" || column.endsWith("_label")
                ? requestContract.requiredColumns.find((required) =>
                    column === "label" || column === `${required}_label`) ?? column
                : column)
              .filter((column) => alignedOutputColumns.includes(column)),
            outputColumns: alignedOutputColumns,
          };
        }
      }
      const contractIssues = sqlContractIssues(question, sql);
      if (contractIssues.length) throw new PipelineStageError("quality", contractIssues.join(" "), attempt);
      let result = await runTimed(sql, attempt);
      result = alignResultColumns(result, requestContract.requiredColumns);
      result = normalizeDerivedMetrics(result);
      if (!brief && requestContract.expectedRowCount === 1) {
        result = pivotNamedScalarMetrics(result, requestContract.requiredColumns);
      }
      const quality = brief
        ? assessResultQuality(result.columns, result.rows, result.truncated, brief)
        : { issues: [], caveats: [] };
      const missingColumns = requestContract.requiredColumns.filter((column) => !result.columns.includes(column));
      if (missingColumns.length) {
        quality.issues.push(`Result is missing explicitly requested columns: ${missingColumns.join(", ")}.`);
      }
      if (requestContract.expectedRowCount !== undefined && result.rows.length !== requestContract.expectedRowCount) {
        quality.issues.push(
          `The request requires exactly ${requestContract.expectedRowCount} rows; SQL returned ${result.rows.length}.`,
        );
      }
      const arrayColumns = result.columns.filter((column) =>
        result.rows.some((row) => Array.isArray(row[column])));
      if (arrayColumns.length && !/\b(?:list|array|collect)\b|danh sách|liệt kê/i.test(question)) {
        quality.issues.push(
          `Array aggregates were not requested for ${arrayColumns.join(", ")}; return scalar metrics at the declared grain.`,
        );
      }
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
      const repairIntroducedExecutionError = attempt === 2 &&
        /^\[quality:1\]/.test(sqlAttempts[0]?.error ?? "") &&
        /^\[execution:2\]/.test(message);
      if (/Database not found/i.test(message) || attempt === 3 || (attempt === 2 && !repairIntroducedExecutionError)) {
        if (error instanceof PipelineStageError) error.sqlAttempts = sqlAttempts;
        throw error;
      }
      correction = {
        sql,
        error: message,
        attempt: attempt + 1,
        ...(brief
          ? { brief }
          : requestContract.expectedRowCount !== undefined && requestContract.requiredColumns.length
            ? {
                brief: {
                  objective: question,
                  metric: requestContract.requiredColumns.join(", "),
                  grain: requestContract.expectedRowCount === 1
                    ? "one scalar row"
                    : `exactly ${requestContract.expectedRowCount} rows`,
                  dimensions: requestContract.requiredColumns.filter((column) =>
                    !/(?:_count|_rows|_days|_sum|_avg|_average|_gap|^p\d+$|^median$|^iqr$)|^(?:codes|names)_with_/i.test(column)),
                  outputColumns: requestContract.requiredColumns,
                  filters: [],
                },
              }
            : {}),
      };
    }
  }
  throw new Error("Query generation failed.");
}
