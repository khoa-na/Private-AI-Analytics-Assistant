import { NextResponse } from "next/server";
import { runReadOnlyQuery } from "@/lib/queryRunner";

export async function POST(request: Request) {
  try {
    const { sql } = (await request.json()) as { sql?: string };
    return NextResponse.json(runReadOnlyQuery(sql ?? ""));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed." },
      { status: 400 },
    );
  }
}
