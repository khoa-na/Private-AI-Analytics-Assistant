import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeResult } from "../lib/llmAnalysis";
import { forEachConcurrent } from "../lib/concurrency";
import { validateStagedBundle } from "../lib/datasetBundle";
import { getDatabasePath } from "../lib/db";
import { generateAndRunQuery } from "../lib/generatedQuery";
import { profileResult } from "../lib/resultProfile";
import {
  CASE_STATUSES,
  caseStatus,
  evaluateExpectedFacts,
  evaluateSummary,
  hasExpectedFacts,
  intentMatchesExpected,
  matchesTextPatterns,
  matchesSqlRequirement,
  type CaseStatus,
  type ExpectedFact,
} from "../lib/summaryEvaluation";
import { runMultiQueryPlan } from "../lib/multiQuery";
import { PipelineStageError } from "../lib/pipelineError";
import { tokenBudget } from "../lib/llmClient";

type EvalCase = {
  id: string;
  category: string;
  language?: "en" | "vi";
  difficulty?: "basic" | "intermediate" | "advanced" | "expert";
  question: string;
  expectedTables: string[];
  outputShape: string;
  acceptedOutputShapes?: string[];
  checks: string[];
  refuse: boolean;
  caveat: boolean;
  requiredSqlPatterns?: string[];
  forbiddenSqlPatterns?: string[];
  expectedColumns?: string[];
  expectedSummaryPatterns?: string[];
  forbiddenSummaryPatterns?: string[];
  requiredMessagePatterns?: string[];
  forbiddenMessagePatterns?: string[];
  requiredCaveatPatterns?: string[];
  forbiddenCaveatPatterns?: string[];
  requiredAnalysisPatterns?: string[];
  forbiddenAnalysisPatterns?: string[];
  expectedRowCount?: number;
  expectedTruncated?: boolean;
  expectedChartType?: "bar" | "line" | "none";
  expectedChart?: {
    type: "bar" | "line" | "none";
    xKey?: string;
    yKeys?: string[];
  };
  expectedColumnsExact?: boolean;
  expectedStepCountMin?: number;
  expectedStepCountMax?: number;
  expectedStepTableGroups?: string[][];
  expectedSteps?: Array<{
    expectedTables: string[];
    expectedColumns?: string[];
    columnAliases?: Record<string, string[]>;
    expectedFacts?: ExpectedFact[];
    expectedRowCount?: number;
    expectedTruncated?: boolean;
    requiredSqlPatterns?: string[];
    forbiddenSqlPatterns?: string[];
  }>;
  expectedFacts?: ExpectedFact[];
};

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "evals/questions.json" },
    dataset: { type: "string" },
    category: { type: "string" },
    ids: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "3" },
  },
});
const suite = values.suite;
if (!values.dataset) throw new Error("--dataset is required for every eval suite.");
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer.");
}
const cases = JSON.parse(readFileSync(suite, "utf8")) as EvalCase[];
let activeDataset: string | undefined;
let activeBundle: Awaited<ReturnType<typeof validateStagedBundle>>["manifest"] | undefined;
if (values.dataset) {
  const { manifest } = await validateStagedBundle(dirname(getDatabasePath()), values.dataset);
  if (manifest.state !== "active" || manifest.dataset !== values.dataset) {
    throw new Error(`Active dataset mismatch: expected ${values.dataset}, found ${manifest.dataset} (${manifest.state}).`);
  }
  activeDataset = manifest.dataset;
  activeBundle = manifest;
}
const category = values.category;
const ids = new Set(values.ids?.split(",").filter(Boolean));
const filtered = cases.filter(
  (test) => (!category || test.category === category) && (!ids.size || ids.has(test.id)),
);
const selected = values.limit ? filtered.slice(0, Number(values.limit)) : filtered;
type EvalResult = { passed: boolean; status: CaseStatus; [key: string]: unknown };
const results = new Map<number, EvalResult>();
const createdAt = new Date().toISOString();
mkdirSync("evals/results", { recursive: true });
const output = join("evals", "results", `eval-${Date.now()}.json`);

function writeReport() {
  const completed = [...results.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, result]) => result);
  const passed = completed.filter((result) => result.passed).length;
  const statusCounts = Object.fromEntries(
    CASE_STATUSES.map((status) => [status, completed.filter((result) => result.status === status).length]),
  );
  writeFileSync(output, `${JSON.stringify({
    createdAt,
    complete: completed.length === selected.length,
    suite,
    concurrency,
    ...(activeDataset ? { dataset: activeDataset } : {}),
    ...(activeBundle ? {
      datasetBundle: {
        database: activeBundle.database,
        artifacts: activeBundle.artifacts,
        generation: activeBundle.generation,
      },
    } : {}),
    model: process.env.OPENAI_MODEL ?? "unknown",
    reasoning: {
      sql: process.env.OPENAI_SQL_REASONING_EFFORT ?? process.env.OPENAI_REASONING_EFFORT ?? "provider-default",
      analysis: process.env.OPENAI_ANALYSIS_REASONING_EFFORT ?? process.env.OPENAI_REASONING_EFFORT ?? "provider-default",
    },
    tokenBudgets: {
      sql: tokenBudget("OPENAI_SQL_MAX_TOKENS", 4096),
      review: tokenBudget("OPENAI_REVIEW_MAX_TOKENS", 2000),
      analysis: tokenBudget("OPENAI_ANALYSIS_MAX_TOKENS", 2400),
    },
    summary: {
      total: completed.length,
      selected: selected.length,
      passed,
      failed: completed.length - passed,
      presentationFailed: statusCounts.PASS_CORE_FAIL_PRESENTATION,
      recovered: statusCounts.PASS_AFTER_REVIEW_REPAIR + statusCounts.PASS_AFTER_SQL_REPAIR,
      statusCounts,
      factCases: selected.filter(
        (test) => test.expectedFacts?.length || test.expectedSummaryPatterns?.length ||
          test.expectedSteps?.some((step) => step.expectedFacts?.length),
      ).length,
    },
    results: completed,
  }, null, 2)}\n`);
  return passed;
}

console.log(`Suite: ${suite}${values.dataset ? ` | Dataset: ${values.dataset}` : ""} | Concurrency: ${concurrency}`);

function hasExpectedShape(shape: string, rowCount: number) {
  if (shape === "empty") return rowCount === 0;
  if (shape === "scalar" || shape === "single_ranked_entity") return rowCount === 1;
  if (["grouped", "ranking", "time_series", "grouped_time_series"].includes(shape)) return rowCount > 0;
  return true;
}

function presentationChecks(test: EvalCase, chart: { type: string; xKey?: string; yKeys?: string[] }) {
  return {
    chartType: test.expectedChartType === undefined || chart.type === test.expectedChartType,
    chart: !test.expectedChart || (
      chart.type === test.expectedChart.type &&
      (test.expectedChart.xKey === undefined || chart.xKey === test.expectedChart.xKey) &&
      (test.expectedChart.yKeys === undefined ||
        JSON.stringify(chart.yKeys) === JSON.stringify(test.expectedChart.yKeys))
    ),
  };
}

function acceptsOutputShape(test: EvalCase, actual: string) {
  if (test.acceptedOutputShapes) return test.acceptedOutputShapes.includes(actual);
  if (actual === "query") {
    return !["clarification", "unsupported", "refusal", "multi_query"].includes(test.outputShape);
  }
  return test.outputShape === actual;
}

function matchesExpectedSteps(test: EvalCase, steps: Awaited<ReturnType<typeof runMultiQueryPlan>>["steps"]) {
  const expected: NonNullable<EvalCase["expectedSteps"]> = [...(test.expectedSteps ??
    (test.expectedStepTableGroups ?? []).map(
      (expectedTables) => ({ expectedTables }),
    ))].sort((left, right) => right.expectedTables.length - left.expectedTables.length);
  const unused = new Set(steps.map((_, index) => index));
  return expected.every((item) => {
    const index = [...unused].find((candidate) => {
      const result = steps[candidate].result;
      const aliases = item.columnAliases ?? {};
      const aliasColumns = new Map(Object.entries(aliases).map(([expected, alternatives]) => [
        expected,
        alternatives.find((column) => result.columns.includes(column)),
      ]));
      const columns = [...result.columns, ...[...aliasColumns]
        .filter(([expected, actual]) => actual && !result.columns.includes(expected))
        .map(([expected]) => expected)];
      const rows = result.rows.map((row) => Object.fromEntries([
        ...Object.entries(row),
        ...[...aliasColumns]
          .filter(([expected, actual]) => actual && !(expected in row))
          .map(([expected, actual]) => [expected, row[actual!]]),
      ]));
      return item.expectedTables.every((table) =>
        new RegExp(`\\b${table}\\b`, "i").test(result.sql),
      ) && (item.expectedColumns ?? []).every((column) => columns.includes(column)) &&
        evaluateExpectedFacts(rows, item.expectedFacts) &&
        (item.expectedRowCount === undefined || result.rows.length === item.expectedRowCount) &&
        (item.expectedTruncated === undefined || result.truncated === item.expectedTruncated) &&
        (item.requiredSqlPatterns ?? []).every((pattern) => matchesSqlRequirement(result.sql, pattern)) &&
        (item.forbiddenSqlPatterns ?? []).every((pattern) => !new RegExp(pattern, "i").test(result.sql));
    });
    if (index === undefined) return false;
    unused.delete(index);
    return true;
  });
}

async function runCase(test: EvalCase, index: number) {
  const started = Date.now();
  const label = `[${index + 1}/${selected.length}] ${test.id}`;
  try {
    const generated = await generateAndRunQuery(test.question);
    if (generated.intent === "multi_query") {
      const multi = await runMultiQueryPlan(test.question, generated);
      multi.timings.sqlGenerationMs += generated.sqlGenerationMs;
      const expectedStepCount = test.expectedSteps?.length ?? test.expectedStepTableGroups?.length;
      const coreChecks = {
        execution: true,
        mode: acceptsOutputShape(test, "multi_query"),
        stepCount: test.expectedStepCountMin !== undefined || test.expectedStepCountMax !== undefined
          ? multi.steps.length >= (test.expectedStepCountMin ?? 2) &&
            multi.steps.length <= (test.expectedStepCountMax ?? 3)
          : expectedStepCount
            ? multi.steps.length === expectedStepCount
            : multi.steps.length >= 2 && multi.steps.length <= 3,
        summaryPresent: Boolean(multi.analysis.summary.trim()),
        summaryEvidence: multi.analysis.summaryEvidence.length > 0,
        expectedSteps: matchesExpectedSteps(test, multi.steps),
        analysisPatterns: matchesTextPatterns(
          [
            multi.analysis.summary,
            ...multi.analysis.insights.map(({ statement }) => statement),
            ...multi.analysis.caveats,
          ].join(" "),
          test.requiredAnalysisPatterns,
          test.forbiddenAnalysisPatterns,
        ),
      };
      const presentation = presentationChecks(test, multi.chart);
      const corePassed = Object.values(coreChecks).every(Boolean);
      const presentationPassed = Object.values(presentation).every(Boolean);
      const dataPassed = coreChecks.execution && coreChecks.mode && coreChecks.stepCount && coreChecks.expectedSteps;
      const sqlRepaired = multi.steps.some((step) => Boolean(step.sqlAttempts?.length));
      const status = caseStatus({
        corePassed,
        presentationPassed,
        reviewRepaired: generated.review?.decision === "repaired",
        sqlRepaired,
        failure: dataPassed ? "analysis" : "correctness",
      });
      const passed = corePassed;
      results.set(index, {
        ...test,
        passed,
        status,
        corePassed,
        presentationPassed,
        automatic: { ...coreChecks, ...presentation },
        diagnostics: {
          expectedStepTables: coreChecks.expectedSteps,
        },
        semanticChecks: test.checks.map((check) => ({ check, verified: null })),
        review: generated.review,
        steps: multi.steps,
        analysis: multi.analysis,
        chart: multi.chart,
        timings: { ...multi.timings, totalMs: Date.now() - started },
      });
      console.log(`${label} ... ${status} (${multi.steps.length} steps)`);
      return;
    }
    if (generated.intent !== "query") {
      const expectedIntent = (["clarification", "unsupported", "refusal"] as const)
        .find((intent) => intent === test.outputShape) ?? (test.refuse ? "refusal" : undefined);
      const intentMatches = intentMatchesExpected(generated.intent, expectedIntent);
      const message = "message" in generated
        ? generated.message
        : "The case unexpectedly required multiple queries.";
      const messageMatches = matchesTextPatterns(
        message,
        test.requiredMessagePatterns,
        test.forbiddenMessagePatterns,
      );
      const passed = intentMatches && messageMatches;
      const status = caseStatus({
        corePassed: passed,
        failure: "correctness",
      });
      results.set(index, {
        ...test,
        passed,
        status,
        corePassed: passed,
        presentationPassed: true,
        automatic: {
          execution: false,
          refusal: generated.intent === "refusal",
          intent: generated.intent,
          intentMatches,
          messageMatches,
        },
        semanticChecks: test.checks.map((check) => ({ check, verified: null })),
        message,
        timings: { sqlGenerationMs: generated.sqlGenerationMs, totalMs: Date.now() - started },
      });
      console.log(`${label} ... ${status} (${generated.intent})`);
      return;
    }
    const profile = profileResult(generated.result.rows, 50, generated.result.truncated);
    const analyzed = await analyzeResult(
      test.question,
      generated.result.sql,
      profile,
      true,
      generated.brief,
      generated.quality.caveats,
    );
    const summaryEvaluation = evaluateSummary(
      analyzed.analysis.summary,
      analyzed.analysis.summaryEvidence,
      analyzed.analysis.caveats,
      profile,
      test.expectedSummaryPatterns,
      test.forbiddenSummaryPatterns,
      generated.result.rows,
      test.question,
    );
    const sql = generated.result.sql.toLowerCase();
    const caveats = analyzed.analysis.caveats.join(" ");
    const analysisText = [
      analyzed.analysis.summary,
      ...analyzed.analysis.insights.map(({ statement }) => statement),
      ...analyzed.analysis.caveats,
    ].join(" ");
    const presentation = presentationChecks(test, analyzed.chart);
    const coreChecks = {
      execution: true,
      mode: acceptsOutputShape(test, "query"),
      refusal: !test.refuse,
      outputShape: hasExpectedShape(test.outputShape, profile.rowCount),
      rowCount: test.expectedRowCount === undefined || profile.rowCount === test.expectedRowCount,
      truncated: test.expectedTruncated === undefined || profile.truncated === test.expectedTruncated,
      caveat: !test.caveat || analyzed.analysis.caveats.length > 0,
      resultFacts: test.expectedFacts
        ? evaluateExpectedFacts(generated.result.rows, test.expectedFacts)
        : test.outputShape === "empty" || hasExpectedFacts(generated.result.rows, test.expectedSummaryPatterns),
      summaryPresent: summaryEvaluation.present,
      summaryEvidence: profile.rowCount === 0
        ? analyzed.analysis.summaryEvidence.length === 0
        : summaryEvaluation.evidenceValid,
      summaryNumbers: summaryEvaluation.numbersGrounded,
      summaryTruncation: summaryEvaluation.truncationValid,
      summaryRequired: summaryEvaluation.requiredPatterns,
      summaryForbidden: summaryEvaluation.forbiddenPatterns,
      summaryComparisons: summaryEvaluation.comparisons.valid,
      expectedTables: test.expectedTables.every((table) =>
        new RegExp(`\\b${table}\\b`, "i").test(sql),
      ),
      requiredSql: (test.requiredSqlPatterns ?? []).every((pattern) =>
        matchesSqlRequirement(sql, pattern),
      ),
      forbiddenSql: (test.forbiddenSqlPatterns ?? []).every(
        (pattern) => !new RegExp(pattern, "i").test(sql),
      ),
      expectedColumns: (test.expectedColumns ?? []).every((column) =>
        generated.result.columns.includes(column),
      ) && (!test.expectedColumnsExact ||
        generated.result.columns.length === (test.expectedColumns ?? []).length),
      caveatPatterns: matchesTextPatterns(
        caveats,
        test.requiredCaveatPatterns,
        test.forbiddenCaveatPatterns,
      ),
      analysisPatterns: matchesTextPatterns(
        analysisText,
        test.requiredAnalysisPatterns,
        test.forbiddenAnalysisPatterns,
      ),
    };
    const corePassed = Object.values(coreChecks).every(Boolean);
    const presentationPassed = Object.values(presentation).every(Boolean);
    const dataPassed = coreChecks.execution && coreChecks.mode && coreChecks.refusal &&
      coreChecks.outputShape && coreChecks.rowCount && coreChecks.truncated && coreChecks.resultFacts &&
      coreChecks.expectedTables && coreChecks.requiredSql && coreChecks.forbiddenSql && coreChecks.expectedColumns;
    const status = caseStatus({
      corePassed,
      presentationPassed,
      reviewRepaired: generated.review?.decision === "repaired",
      sqlRepaired: Boolean(generated.sqlAttempts?.length),
      failure: !coreChecks.refusal ? "safety" : dataPassed ? "analysis" : "correctness",
    });
    const passed = corePassed;
    results.set(index, {
      ...test,
      passed,
      status,
      corePassed,
      presentationPassed,
      automatic: { ...coreChecks, ...presentation },
      diagnostics: {
        expectedTables: coreChecks.expectedTables,
        requiredSql: coreChecks.requiredSql,
        forbiddenSql: coreChecks.forbiddenSql,
        expectedColumns: coreChecks.expectedColumns,
        expectedSummaryPatterns: (test.expectedSummaryPatterns ?? []).every((pattern) =>
          new RegExp(pattern, "i").test(analyzed.analysis.summary),
        ),
      },
      semanticChecks: test.checks.map((check) => ({ check, verified: null })),
      brief: generated.brief,
      review: generated.review,
      sqlAttempts: generated.sqlAttempts,
      quality: generated.quality,
      sql: generated.result.sql,
      rowCount: profile.rowCount,
      analysis: analyzed.analysis,
      summaryEvaluation,
      chart: analyzed.chart,
      timings: {
        sqlGenerationMs: generated.sqlGenerationMs,
        queryMs: generated.queryMs,
        analysisMs: Date.now() - started - generated.sqlGenerationMs - generated.queryMs,
        totalMs: Date.now() - started,
      },
    });
    console.log(`${label} ... ${status}`);
  } catch (error) {
    const status = caseStatus({
      corePassed: false,
      failure: error instanceof PipelineStageError && error.stage === "analysis" ? "analysis" : "pipeline",
    });
    results.set(index, {
      ...test,
      passed: false,
      status,
      corePassed: false,
      presentationPassed: false,
      automatic: { execution: false, refusal: false },
      semanticChecks: test.checks.map((check) => ({ check, verified: null })),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PipelineStageError
        ? {
            failureStage: error.stage,
            failureAttempt: error.attempt,
            ...(error.sqlAttempts?.length ? { sqlAttempts: error.sqlAttempts } : {}),
          }
        : {}),
      timings: { totalMs: Date.now() - started },
    });
    console.log(`${label} ... ${status}`);
  } finally {
    writeReport();
  }
}

await forEachConcurrent(selected, concurrency, runCase);

const passed = writeReport();
console.log(`\n${passed}/${results.size} passed. Report: ${output}`);
process.exitCode = passed === results.size ? 0 : 1;
