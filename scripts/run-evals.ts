import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeResult } from "../lib/llmAnalysis";
import { generateAndRunQuery } from "../lib/generatedQuery";
import { profileResult } from "../lib/resultProfile";
import { evaluateSummary } from "../lib/summaryEvaluation";
import { runMultiQueryPlan } from "../lib/multiQuery";

type EvalCase = {
  id: string;
  category: string;
  question: string;
  expectedTables: string[];
  outputShape: string;
  checks: string[];
  refuse: boolean;
  caveat: boolean;
  requiredSqlPatterns?: string[];
  forbiddenSqlPatterns?: string[];
  expectedColumns?: string[];
  expectedSummaryPatterns?: string[];
  forbiddenSummaryPatterns?: string[];
  expectedStepTableGroups?: string[][];
};

const cases = JSON.parse(readFileSync("evals/questions.json", "utf8")) as EvalCase[];
const categoryArg = process.argv.find((arg) => arg.startsWith("--category="));
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const category = categoryArg?.split("=")[1];
const filtered = category ? cases.filter((test) => test.category === category) : cases;
const selected = limitArg ? filtered.slice(0, Number(limitArg.split("=")[1])) : filtered;
const results = [];

function hasExpectedShape(shape: string, rowCount: number) {
  if (shape === "scalar" || shape === "single_ranked_entity") return rowCount === 1;
  if (["grouped", "ranking", "time_series", "grouped_time_series"].includes(shape)) return rowCount > 0;
  return true;
}

for (const [index, test] of selected.entries()) {
  const started = Date.now();
  process.stdout.write(`[${index + 1}/${selected.length}] ${test.id} ... `);
  try {
    const generated = await generateAndRunQuery(test.question);
    if (generated.intent === "multi_query") {
      const multi = await runMultiQueryPlan(test.question, generated);
      const sqlByStep = multi.steps.map(({ result }) => result.sql.toLowerCase());
      const automatic = {
        execution: true,
        mode: test.outputShape === "multi_query",
        stepCount: multi.steps.length >= 2 && multi.steps.length <= 3,
        tables: (test.expectedStepTableGroups ?? []).every((group) =>
          sqlByStep.some((sql) =>
            group.every((table) => new RegExp(`\\b${table}\\b`, "i").test(sql)),
          ),
        ),
        summaryPresent: Boolean(multi.analysis.summary.trim()),
        summaryEvidence: multi.analysis.summaryEvidence.length > 0,
      };
      const passed = Object.values(automatic).every(Boolean);
      results.push({
        ...test,
        passed,
        automatic,
        semanticChecks: test.checks.map((check) => ({ check, verified: null })),
        steps: multi.steps,
        analysis: multi.analysis,
        chart: multi.chart,
        timings: { ...multi.timings, totalMs: Date.now() - started },
      });
      console.log(passed ? `PASS (${multi.steps.length} steps)` : "FAIL");
      continue;
    }
    if (generated.intent !== "query") {
      const passed =
        (test.outputShape === "clarification" && generated.intent === "clarification") ||
        (test.outputShape === "unsupported" && generated.intent === "unsupported") ||
        (test.refuse && generated.intent === "refusal");
      results.push({
        ...test,
        passed,
        automatic: {
          execution: false,
          refusal: generated.intent === "refusal",
          intent: generated.intent,
        },
        semanticChecks: test.checks.map((check) => ({ check, verified: null })),
        message: "message" in generated
          ? generated.message
          : "The case unexpectedly required multiple queries.",
        timings: { sqlGenerationMs: generated.sqlGenerationMs, totalMs: Date.now() - started },
      });
      console.log(passed ? `PASS (${generated.intent})` : "FAIL");
      continue;
    }
    const profile = profileResult(generated.result.rows, 50, generated.result.truncated);
    const analyzed = await analyzeResult(test.question, generated.result.sql, profile);
    const summaryEvaluation = evaluateSummary(
      analyzed.analysis.summary,
      analyzed.analysis.summaryEvidence,
      analyzed.analysis.caveats,
      profile,
      test.expectedSummaryPatterns,
      test.forbiddenSummaryPatterns,
      generated.result.rows,
    );
    const sql = generated.result.sql.toLowerCase();
    const automatic = {
      execution: true,
      refusal: !test.refuse,
      tables: test.expectedTables.every((table) => new RegExp(`\\b${table}\\b`, "i").test(sql)),
      outputShape: hasExpectedShape(test.outputShape, profile.rowCount),
      caveat: !test.caveat || analyzed.analysis.caveats.length > 0,
      requiredSql: (test.requiredSqlPatterns ?? []).every((pattern) =>
        new RegExp(pattern, "i").test(sql),
      ),
      forbiddenSql: (test.forbiddenSqlPatterns ?? []).every(
        (pattern) => !new RegExp(pattern, "i").test(sql),
      ),
      columns: (test.expectedColumns ?? []).every((column) =>
        generated.result.columns.includes(column),
      ),
      summaryPresent: summaryEvaluation.present,
      summaryEvidence: summaryEvaluation.evidenceValid,
      summaryNumbers: summaryEvaluation.numbersGrounded,
      summaryTruncation: summaryEvaluation.truncationValid,
      summaryRequired: summaryEvaluation.requiredPatterns,
      summaryForbidden: summaryEvaluation.forbiddenPatterns,
      summaryComparisons: summaryEvaluation.comparisons.valid,
    };
    const passed = Object.values(automatic).every(Boolean);
    results.push({
      ...test,
      passed,
      automatic,
      semanticChecks: test.checks.map((check) => ({ check, verified: null })),
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
    console.log(passed ? "PASS" : "FAIL");
  } catch (error) {
    results.push({
      ...test,
      passed: false,
      automatic: { execution: false, refusal: false },
      semanticChecks: test.checks.map((check) => ({ check, verified: null })),
      error: error instanceof Error ? error.message : String(error),
      timings: { totalMs: Date.now() - started },
    });
    console.log("FAIL");
  }
}

const passed = results.filter((result) => result.passed).length;
const report = {
  createdAt: new Date().toISOString(),
  model: process.env.OPENAI_MODEL ?? "unknown",
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
};
mkdirSync("evals/results", { recursive: true });
const output = join("evals", "results", `eval-${Date.now()}.json`);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${passed}/${results.length} passed. Report: ${output}`);
process.exitCode = passed === results.length ? 0 : 1;
