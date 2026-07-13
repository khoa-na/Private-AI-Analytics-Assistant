import type { ResultProfile, Row } from "./analyticsTypes";

export function profileResult(rows: Row[], sampleSize = 50, truncated = false): ResultProfile {
  const names = rows.length ? Object.keys(rows[0]) : [];
  const columns = names.map((name) => {
    const values = rows.map((row) => row[name]);
    const present = values.filter((value) => value !== null);
    const numbers = present.filter(
      (value): value is number => typeof value === "number",
    );
    const numeric = present.length > 0 && numbers.length === present.length;

    return {
      name,
      type: present.length ? (numeric ? "number" as const : "string" as const) : "null" as const,
      nullCount: values.length - present.length,
      ...(numeric
        ? {
            min: Math.min(...numbers),
            max: Math.max(...numbers),
            average: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
          }
        : {}),
    };
  });

  let sampleRows = rows;
  if (rows.length > sampleSize) {
    const selected = new Set<number>();
    const add = (index: number) => {
      if (selected.size < sampleSize && index >= 0) selected.add(index);
    };
    add(0);
    add(rows.length - 1);
    // ponytail: very wide results prioritize earlier numeric columns when extrema exceed the sample budget.
    for (const column of columns) {
      if (column.type !== "number") continue;
      add(rows.findIndex((row) => row[column.name] === column.max));
      add(rows.findIndex((row) => row[column.name] === column.min));
    }
    for (let index = 0; selected.size < sampleSize && index < sampleSize; index += 1) {
      add(Math.round(index * (rows.length - 1) / (sampleSize - 1)));
    }
    for (let index = 0; selected.size < sampleSize; index += 1) add(index);
    sampleRows = [...selected].sort((left, right) => left - right).map((index) => rows[index]);
  }

  return {
    rowCount: rows.length,
    truncated,
    columns,
    sampleRows,
  };
}
