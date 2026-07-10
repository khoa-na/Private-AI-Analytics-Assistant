import { NextResponse } from "next/server";
import { generateSql } from "@/lib/llmSql";

export async function POST(request: Request) {
  try {
    const { question } = (await request.json()) as { question?: string };
    if (!question?.trim()) {
      return NextResponse.json({ error: "Question is required." }, { status: 400 });
    }

    return NextResponse.json({
      sql: await generateSql(question),
      reason: "Generated SQL from the database schema.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
