import { parseLastJsonObject } from "./jsonOutput";
import { validateReadOnlySql } from "./sqlSafety";

export function extractSqlFromModelOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Model returned an empty response.");

  const candidates: string[] = [];
  try {
    const parsed = parseLastJsonObject(trimmed) as { sql?: unknown };
    if (typeof parsed.sql === "string" && parsed.sql.trim()) {
      candidates.push(parsed.sql.trim());
    }
  } catch {
    // Most providers return plain SQL; JSON is only a compatibility path.
  }

  const addCandidate = (text: string) => {
    const match = text.match(/\b(WITH|SELECT)\b[\s\S]*/i);
    if (!match) return;
    const semicolon = match[0].indexOf(";");
    candidates.push((semicolon >= 0 ? match[0].slice(0, semicolon + 1) : match[0]).trim());
  };

  const fences = [...trimmed.matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi)];
  for (const fence of fences.reverse()) addCandidate(fence[1]);

  const sections = trimmed.split(/<\/think>|<\|end(?:_of_)?thinking\|>|<｜end▁of▁thinking｜>/gi);
  addCandidate(sections.at(-1) ?? trimmed);
  if (sections.length > 1) addCandidate(trimmed);

  for (const candidate of candidates) {
    try {
      validateReadOnlySql(candidate);
      return candidate;
    } catch {
      // Try the next provider-output candidate; execution owns the final error.
    }
  }

  if (!candidates.length) throw new Error("Model response did not contain SQL.");
  return candidates[0];
}
