export function parseLastJsonObject(output: string): Record<string, unknown> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: Record<string, unknown> | undefined;

  // ponytail: linear scan is enough while model output is token-bounded.
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const value = JSON.parse(output.slice(start, index + 1)) as unknown;
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            last = value as Record<string, unknown>;
          }
        } catch {
          // Ignore provider reasoning fragments and keep scanning for a final object.
        }
      }
    }
  }
  if (!last) throw new Error("Model returned no valid JSON object.");
  return last;
}
