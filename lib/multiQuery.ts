import type { Analysis, AnalysisStep, ChartSpec, Row } from "./analyticsTypes";
import { generateAndRunQuery } from "./generatedQuery";
import { analyzeResult } from "./llmAnalysis";
import { generateGeneralSql } from "./llmSql";
import type { MultiQueryPlan } from "./queryPlan";
import { profileResult } from "./resultProfile";

export async function runMultiQueryPlan(
  question: string,
  plan: MultiQueryPlan,
  runStep = (stepQuestion: string) => generateAndRunQuery(stepQuestion, generateGeneralSql),
  analyze = analyzeResult,
): Promise<{
  steps: AnalysisStep[];
  analysis: Analysis;
  chart: ChartSpec;
  followUpQuestions: string[];
  timings: { sqlGenerationMs: number; queryMs: number; analysisMs: number };
}> {
  const steps: AnalysisStep[] = [];
  let sqlGenerationMs = 0;
  let queryMs = 0;

  for (const step of plan.steps) {
    const generated = await runStep([
      step.question,
      `Required result grain: ${step.requiredGrain}.`,
      `Required filters: ${step.filters.length ? step.filters.join("; ") : "none"}.`,
    ].join("\n"));
    sqlGenerationMs += generated.sqlGenerationMs;
    queryMs += generated.queryMs;
    if (generated.intent !== "query") {
      throw new Error(`Analysis step could not produce one query: ${step.purpose}`);
    }
    steps.push({ ...step, result: generated.result });
  }

  const ledger: Row = {};
  for (const [stepIndex, step] of steps.entries()) {
    // ponytail: ten rows per step bounds prompt size; add result summarization if complex evals need more coverage.
    for (const [rowIndex, row] of step.result.rows.slice(0, 10).entries()) {
      for (const [column, value] of Object.entries(row)) {
        ledger[`step_${stepIndex + 1}.row_${rowIndex + 1}.${column}`] = value;
      }
    }
  }
  if (!Object.keys(ledger).length) throw new Error("The analysis steps returned no evidence.");

  const started = Date.now();
  const analyzed = await analyze(
    question,
    steps.map((step) => `-- ${step.purpose}\n${step.result.sql}`).join("\n\n"),
    profileResult([ledger], 1, steps.some((step) => step.result.truncated)),
    false,
  );

  return {
    steps,
    ...analyzed,
    timings: { sqlGenerationMs, queryMs, analysisMs: Date.now() - started },
  };
}
