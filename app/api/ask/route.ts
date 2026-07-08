import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getSchemaText } from "@/lib/schema";
import { withDefaultLimit } from "@/lib/sqlSafety";

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !model) {
      return NextResponse.json(
        { error: "Set OPENAI_API_KEY and OPENAI_MODEL in .env.local." },
        { status: 400 },
      );
    }

    const { question } = (await request.json()) as { question?: string };
    if (!question?.trim()) {
      return NextResponse.json({ error: "Question is required." }, { status: 400 });
    }

    const client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: [
            "You generate SQLite SELECT queries for ecommerce analytics.",
            "Return only valid JSON with keys sql and reason.",
            "The sql value must be one read-only SELECT statement.",
            "Use only tables and columns from the schema.",
            "Cast numeric CSV text fields with CAST(column AS REAL) before math.",
            "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, or multiple statements.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Schema:\n${getSchemaText()}\n\nQuestion: ${question}`,
        },
      ],
    });

    const content = completion.choices[0]?.message.content ?? "{}";
    const parsed = JSON.parse(content) as { sql?: string; reason?: string };
    const safeSql = withDefaultLimit(parsed.sql ?? "");

    return NextResponse.json({
      sql: safeSql,
      reason: parsed.reason ?? "Generated SQL from the database schema.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
