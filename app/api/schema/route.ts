import { NextResponse } from "next/server";
import { getSchema } from "@/lib/schema";

export async function GET() {
  try {
    return NextResponse.json({ schema: await getSchema() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load schema." },
      { status: 500 },
    );
  }
}
