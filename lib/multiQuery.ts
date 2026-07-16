import type { Analysis, AnalysisStep, ChartSpec, Row } from "./analyticsTypes";
import { generateAndRunQuery } from "./generatedQuery";
import { analyzeResult } from "./llmAnalysis";
import { generateGeneralSql } from "./llmSql";
import type { MultiQueryPlan } from "./queryPlan";
import { profileResult } from "./resultProfile";

type PlannedStep = MultiQueryPlan["steps"][number];

function runPlannedStep(step: PlannedStep) {
  return generateAndRunQuery(
    step.question,
    async (_question, correction) => correction
      ? generateGeneralSql(step.question, correction)
      : { intent: "query", brief: step.brief, sql: step.sql },
  );
}

export async function runMultiQueryPlan(
  question: string,
  plan: MultiQueryPlan,
  runStep: (step: PlannedStep) => ReturnType<typeof runPlannedStep> = runPlannedStep,
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
    const generated = await runStep(step);
    sqlGenerationMs += generated.sqlGenerationMs;
    queryMs += generated.queryMs;
    if (generated.intent !== "query") {
      throw new Error(`Analysis step could not produce one query: ${step.purpose}`);
    }
    steps.push({
      ...step,
      ...(generated.sqlAttempts?.length ? { sqlAttempts: generated.sqlAttempts } : {}),
      quality: generated.quality,
      result: generated.result,
    });
  }

  const evidenceRows: Row[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    for (const [rowIndex, row] of step.result.rows.entries()) {
      evidenceRows.push({
        analysis_step: `${stepIndex + 1}: ${step.purpose}`,
        row_number: rowIndex + 1,
        ...row,
      });
    }
  }
  if (!evidenceRows.length) throw new Error("The analysis steps returned no evidence.");

  const started = Date.now();
  const analyzed = await analyze(
    question,
    steps.map((step) => `-- ${step.purpose}\n${step.result.sql}`).join("\n\n"),
    profileResult(evidenceRows, 50, steps.some((step) => step.result.truncated)),
    false,
    plan.brief,
    steps.flatMap((step) => step.quality.caveats),
  );

  return {
    steps,
    ...analyzed,
    timings: { sqlGenerationMs, queryMs, analysisMs: Date.now() - started },
  };
}
