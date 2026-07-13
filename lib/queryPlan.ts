export type MultiQueryPlan = {
  intent: "multi_query";
  steps: Array<{
    kind: "query";
    purpose: string;
    question: string;
    requiredGrain: string;
    filters: string[];
  }>;
};

export type IntentResponse =
  | MultiQueryPlan
  | { intent: "clarification" | "unsupported" | "refusal"; message: string };
