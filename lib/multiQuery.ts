import type { Analysis, AnalysisStep, ChartSpec, Row } from "./analyticsTypes";
import {
  alignExplicitOutputColumns,
  explicitResultContract,
  generateAndRunQuery,
} from "./generatedQuery";
import { analyzeResult } from "./llmAnalysis";
import { generateGeneralSql } from "./llmSql";
import type { MultiQueryPlan } from "./queryPlan";
import { profileResult } from "./resultProfile";

type PlannedStep = MultiQueryPlan["steps"][number];

export function applyParentResultContract(question: string, steps: PlannedStep[]) {
  const contract = explicitResultContract(question);
  const planned = steps.map((step) => ({
    ...step,
    ...(step.brief
      ? { brief: { ...step.brief, outputColumns: [...step.brief.outputColumns] } }
      : {}),
  }));
  const declared = new Set(planned.flatMap((step) => step.brief?.outputColumns ?? []));

  for (const column of contract.requiredColumns) {
    if (declared.has(column)) continue;
    const terms = column.toLowerCase().split("_")
      .filter((term) => term.length > 2 && !["average", "count", "rows", "value"].includes(term));
    const scores = planned.map((step) => {
      if (!step.brief) return 0;
      const text = [
        step.purpose,
        step.question,
        step.brief.objective,
        step.brief.metric,
        ...step.brief.outputColumns,
      ].join(" ").toLowerCase();
      return terms.filter((term) => text.includes(term)).length;
    });
    const bestScore = Math.max(...scores);
    if (bestScore > 0) {
      const brief = planned[scores.indexOf(bestScore)].brief!;
      brief.outputColumns = alignExplicitOutputColumns(brief.outputColumns, [column]);
      declared.add(column);
    }
  }
  if (contract.expectedRowCount !== undefined) {
    const scores = planned.map((step) => step.brief?.outputColumns
      .filter((column) => contract.requiredColumns.includes(column)).length ?? 0);
    const bestScore = Math.max(...scores);
    if (bestScore > 0) {
      const brief = planned[scores.indexOf(bestScore)].brief!;
      brief.grain = `${brief.grain}; exactly ${contract.expectedRowCount} rows`;
    }
  }
  return planned;
}

function runPlannedStep(step: PlannedStep) {
  if (!step.brief) return generateAndRunQuery(step.question);
  const brief = step.brief;
  return generateAndRunQuery(
    step.question,
    async (_question, correction) => correction
      ? generateGeneralSql(step.question, correction)
      : { intent: "query", brief, sql: step.sql },
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

  const plannedSteps = applyParentResultContract(question, plan.steps);
  const generatedSteps = await Promise.all(plannedSteps.map(runStep));
  for (const [index, generated] of generatedSteps.entries()) {
    const step = plannedSteps[index];
    sqlGenerationMs += generated.sqlGenerationMs;
    queryMs += generated.queryMs;
    if (generated.intent !== "query") {
      throw new Error(`Analysis step could not produce one query: ${step.purpose}`);
    }
    const brief = generated.brief ?? step.brief;
    if (!brief) throw new Error(`Analysis step returned no executable brief: ${step.purpose}`);
    steps.push({
      ...step,
      brief,
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
