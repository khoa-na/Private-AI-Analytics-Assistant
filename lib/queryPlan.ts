export type AnalysisBrief = {
  objective: string;
  metric: string;
  grain: string;
  dimensions: string[];
  outputColumns: string[];
  filters: string[];
  comparison?: string;
};

export type PlanReview = {
  decision: "approved" | "repaired" | "unavailable";
  issues: string[];
};

export type QueryPlan = {
  intent: "query";
  brief: AnalysisBrief;
  sql: string;
  review?: PlanReview;
};

export type MultiQueryPlan = {
  intent: "multi_query";
  brief: AnalysisBrief;
  review?: PlanReview;
  steps: Array<{
    kind: "query";
    purpose: string;
    question: string;
    brief: AnalysisBrief;
    sql: string;
  }>;
};

export type IntentResponse =
  | QueryPlan
  | MultiQueryPlan
  | { intent: "clarification" | "unsupported" | "refusal"; message: string };
