import { NextResponse } from "next/server";
import { analyzeResult } from "@/lib/llmAnalysis";
import { generateAndRunQuery } from "@/lib/generatedQuery";
import { profileResult } from "@/lib/resultProfile";
import { runMultiQueryPlan } from "@/lib/multiQuery";

export async function POST(request: Request) {
  try {
    const { question } = (await request.json()) as { question?: string };
    if (!question?.trim()) {
      return NextResponse.json({ error: "Question is required." }, { status: 400 });
    }

    const generated = await generateAndRunQuery(question);
    if (generated.intent === "multi_query") {
      const multi = await runMultiQueryPlan(question, generated);
      multi.timings.sqlGenerationMs += generated.sqlGenerationMs;
      return NextResponse.json({
        question,
        intent: "query",
        mode: "multi_query",
        steps: multi.steps,
        analysis: multi.analysis,
        chart: multi.chart,
        followUpQuestions: multi.followUpQuestions,
        timings: multi.timings,
      });
    }
    if (generated.intent !== "query") {
      return NextResponse.json({ question, ...generated });
    }
    const { result, sqlGenerationMs, queryMs } = generated;
    const queried = Date.now();
    const profile = profileResult(result.rows, 50, result.truncated);
    let analyzed;
    try {
      analyzed = await analyzeResult(question, result.sql, profile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Analysis failed.";
      analyzed = {
        analysis: {
          summary: "The query succeeded, but the model analysis could not be parsed.",
          summaryEvidence: [],
          insights: [],
          caveats: [reason],
        },
        chart: {
          type: "none" as const,
          reason: "The model did not return a valid chart recommendation.",
        },
        followUpQuestions: [],
      };
    }

    return NextResponse.json({
      question,
      result: {
        sql: result.sql,
        columns: result.columns,
        rows: result.rows,
        rowCount: profile.rowCount,
        truncated: profile.truncated,
      },
      ...analyzed,
      timings: {
        sqlGenerationMs,
        queryMs,
        analysisMs: Date.now() - queried,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed." },
      { status: 400 },
    );
  }
}
