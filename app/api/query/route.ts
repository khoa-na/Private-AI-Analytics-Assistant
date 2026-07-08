import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { withDefaultLimit } from "@/lib/sqlSafety";

export async function POST(request: Request) {
  try {
    const { sql } = (await request.json()) as { sql?: string };
    const safeSql = withDefaultLimit(sql ?? "");
    const db = getDb();
    const statement = db.prepare(safeSql);
    const rows = statement.all() as Record<string, unknown>[];
    const columns = statement.columns().map((column) => column.name);
    db.close();

    return NextResponse.json({ sql: safeSql, columns, rows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed." },
      { status: 400 },
    );
  }
}
