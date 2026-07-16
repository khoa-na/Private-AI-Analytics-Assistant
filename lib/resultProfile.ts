import type { ResultProfile, Row } from "./analyticsTypes";
import type { AnalysisBrief } from "./queryPlan";

export type ResultQuality = {
  issues: string[];
  caveats: string[];
};

export function evidenceFromRows(rows: Row[]) {
  return new Set(
    rows.flatMap((row) =>
      Object.entries(row).map(([column, value]) =>
        column === "analysis_step" || !("analysis_step" in row)
          ? `${column} = ${String(value)}`
          : `${String(row.analysis_step)}: ${column} = ${String(value)}`,
      ),
    ),
  );
}

export function assessResultQuality(
  columns: string[],
  rows: Row[],
  truncated: boolean,
  brief: AnalysisBrief,
): ResultQuality {
  const missing = brief.outputColumns.filter((column) => !columns.includes(column));
  const issues = missing.length
    ? [`Result is missing required output columns: ${missing.join(", ")}.`]
    : [];

  if (rows.length > 1 && brief.dimensions.length === 0) {
    issues.push(`Brief declares scalar grain but SQL returned ${rows.length} rows.`);
  } else if (rows.length > 1 && brief.dimensions.every((column) => columns.includes(column))) {
    const keys = rows.map((row) => JSON.stringify(brief.dimensions.map((column) => row[column] ?? null)));
    if (new Set(keys).size !== keys.length) {
      issues.push(`Result contains duplicate rows at the declared grain: ${brief.dimensions.join(", ")}.`);
    }
  }

  const caveats = [
    ...(!rows.length ? ["The query returned no rows."] : []),
    ...(truncated ? ["The query result was truncated by the row limit."] : []),
    ...brief.outputColumns
      .filter((column) => columns.includes(column) && rows.length > 0 && rows.every((row) => row[column] == null))
      .map((column) => `${column} contains only null values.`),
  ];
  return { issues, caveats };
}

export function profileResult(rows: Row[], sampleSize = 50, truncated = false): ResultProfile {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const columns = names.map((name) => {
    const values = rows.filter((row) => Object.hasOwn(row, name)).map((row) => row[name]);
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
