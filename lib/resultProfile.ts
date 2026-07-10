import type { ResultProfile, Row } from "./analyticsTypes";

export function profileResult(rows: Row[], sampleSize = 50): ResultProfile {
  const names = rows.length ? Object.keys(rows[0]) : [];

  return {
    rowCount: rows.length,
    // ponytail: LIMIT 1000 cannot distinguish an exact 1000-row result; add a
    // count query only when exact totals are needed.
    truncated: rows.length >= 1000,
    columns: names.map((name) => {
      const values = rows.map((row) => row[name]);
      const present = values.filter((value) => value !== null);
      const numbers = present.filter(
        (value): value is number => typeof value === "number",
      );
      const numeric = present.length > 0 && numbers.length === present.length;

      return {
        name,
        type: present.length ? (numeric ? "number" : "string") : "null",
        nullCount: values.length - present.length,
        ...(numeric
          ? {
              min: Math.min(...numbers),
              max: Math.max(...numbers),
              average: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
            }
          : {}),
      };
    }),
    sampleRows: rows.slice(0, sampleSize),
  };
}
