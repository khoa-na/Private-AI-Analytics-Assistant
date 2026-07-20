import type { AnalysisBrief } from "./queryPlan";

export type Schema = Record<string, string[]>;

export type CellValue = string | number | null | CellValue[] | { [key: string]: CellValue };
export type Row = Record<string, CellValue>;

export type ResultProfile = {
  rowCount: number;
  truncated: boolean;
  columns: Array<{
    name: string;
    type: "number" | "string" | "null";
    nullCount: number;
    min?: number;
    max?: number;
    average?: number;
  }>;
  sampleRows: Row[];
};

export type ChartSpec = {
  type: "bar" | "line" | "none";
  reason: string;
  xKey?: string;
  yKeys?: string[];
};

export type Analysis = {
  summary: string;
  summaryEvidence: string[];
  insights: Array<{ statement: string; evidence: string[] }>;
  caveats: string[];
};

export type AnalysisStep = {
  kind: "query";
  purpose: string;
  question: string;
  brief: AnalysisBrief;
  sql: string;
  sourceTables?: string[];
  sqlAttempts?: Array<{ attempt: number; sql: string; error: string }>;
  quality: { issues: string[]; caveats: string[] };
  result: {
    sql: string;
    columns: string[];
    rows: Row[];
    truncated: boolean;
  };
};
