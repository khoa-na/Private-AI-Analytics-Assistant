export function extractSqlFromModelOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Model returned an empty response.");

  try {
    const parsed = JSON.parse(trimmed) as { sql?: unknown };
    if (typeof parsed.sql === "string" && parsed.sql.trim()) {
      return parsed.sql.trim();
    }
  } catch {
    // Local llama.cpp models often ignore JSON mode; fall through to SQL extraction.
  }

  const fenced = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const match = candidate.match(/\b(WITH|SELECT)\b[\s\S]*/i);
  if (!match) throw new Error("Model response did not contain SQL.");

  const sql = match[0].trim();
  const semicolon = sql.indexOf(";");
  return semicolon >= 0 ? sql.slice(0, semicolon + 1) : sql;
}
