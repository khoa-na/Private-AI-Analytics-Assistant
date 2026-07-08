import { NextResponse } from "next/server";
import { getSchemaText } from "@/lib/schema";
import { extractSqlFromModelOutput } from "@/lib/sqlExtraction";
import { withDefaultLimit } from "@/lib/sqlSafety";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: { message?: string };
};

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
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

    const body = {
      model,
      temperature: 0.1,
      max_tokens: 320,
      ...(process.env.OPENAI_BASE_URL
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
      messages: [
        {
          role: "system",
          content: [
            "You generate SQLite SELECT queries for ecommerce analytics.",
            "Questions can be written in English or Vietnamese; translate the user intent internally.",
            "Return only the SQL query. Do not return markdown, JSON, explanations, or comments.",
            "The SQL must answer the exact current user question, not a previous or example question.",
            "The SQL must be one read-only SELECT statement.",
            "Use only tables and columns from the schema.",
            "Cast numeric CSV text fields with CAST(column AS REAL) before math.",
            "For product category review questions, join order_reviews to order_items by order_id, then products by product_id, then category_translation by product_category_name.",
            "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, or multiple statements.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "/no_think",
            `Schema:\n${getSchemaText()}`,
            "Example Vietnamese intent:",
            "Question: Danh mục sản phẩm nào có điểm đánh giá trung bình thấp nhất?",
            "SQL: SELECT COALESCE(t.product_category_name_english, p.product_category_name) AS category, ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score, COUNT(DISTINCT r.order_id) AS reviewed_orders FROM order_reviews r JOIN order_items oi ON r.order_id = oi.order_id JOIN products p ON oi.product_id = p.product_id LEFT JOIN category_translation t ON p.product_category_name = t.product_category_name GROUP BY category HAVING reviewed_orders >= 20 ORDER BY avg_review_score ASC, reviewed_orders DESC LIMIT 15",
            `Question: ${question}`,
          ].join("\n\n"),
        },
      ],
    };

    const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const completion = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(completion.error?.message ?? "AI request failed.");
    }

    const message = completion.choices?.[0]?.message;
    const content = message?.content || message?.reasoning_content || "";
    const safeSql = withDefaultLimit(extractSqlFromModelOutput(content));

    return NextResponse.json({
      sql: safeSql,
      reason: "Generated SQL from the database schema.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
