export type Schema = Record<string, string[]>;

export type Row = Record<string, string | number | null>;

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
