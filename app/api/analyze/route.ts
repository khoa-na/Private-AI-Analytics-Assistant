import { NextResponse } from "next/server";
import { analyzeResult } from "@/lib/llmAnalysis";
import { generateAndRunQuery } from "@/lib/generatedQuery";
import { profileResult } from "@/lib/resultProfile";

export async function POST(request: Request) {
  try {
    const { question } = (await request.json()) as { question?: string };
    if (!question?.trim()) {
      return NextResponse.json({ error: "Question is required." }, { status: 400 });
    }

    const { result, sqlGenerationMs, queryMs } =
      await generateAndRunQuery(question);
    const queried = Date.now();
    const profile = profileResult(result.rows);
    let analyzed;
    try {
      analyzed = await analyzeResult(question, result.sql, profile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Analysis failed.";
      analyzed = {
        analysis: {
          summary: "The query succeeded, but the model analysis could not be parsed.",
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
