import { NextResponse } from "next/server";
import type { Row } from "@/lib/analyticsTypes";
import { analyzeResult } from "@/lib/llmAnalysis";
import { profileResult } from "@/lib/resultProfile";

function isRow(value: unknown): value is Row {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => item === null || ["string", "number"].includes(typeof item),
    )
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      question?: unknown;
      sql?: unknown;
      rows?: unknown;
      truncated?: unknown;
    };
    if (
      typeof body.question !== "string" ||
      !body.question.trim() ||
      body.question.length > 2000 ||
      typeof body.sql !== "string" ||
      !body.sql.trim() ||
      body.sql.length > 20_000 ||
      !Array.isArray(body.rows) ||
      body.rows.length > 1000 ||
      !body.rows.every(isRow) ||
      typeof body.truncated !== "boolean"
    ) {
      return NextResponse.json({ error: "Invalid insight request." }, { status: 400 });
    }

    const profile = profileResult(body.rows, 50, body.truncated);
    const analyzed = await analyzeResult(body.question, body.sql, profile, false);
    return NextResponse.json({
      analysis: analyzed.analysis,
      followUpQuestions: analyzed.followUpQuestions,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Insight generation failed." },
      { status: 400 },
    );
  }
}
