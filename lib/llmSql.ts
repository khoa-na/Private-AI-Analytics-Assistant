import { getDatasetGuide } from "./datasetGuide";
import { completeChat, stageReasoningEffort, tokenBudget, type ChatMessage } from "./llmClient";
import { parseLastJsonObject } from "./jsonOutput";
import { atStage } from "./pipelineError";
import { privacyRefusalForQuestion } from "./privacySafety";
import type { AnalysisBrief, IntentResponse, MultiQueryPlan, QueryPlan } from "./queryPlan";
import { getSchemaText } from "./schema";
import { extractSqlFromModelOutput } from "./sqlExtraction";

export type SqlCorrection = {
  sql: string;
  error: string;
  attempt?: number;
  brief?: AnalysisBrief;
};

export function getSqlContext() {
  return `Schema:\n${getSchemaText()}\n\nDataset semantics:\n${getDatasetGuide()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function needsSqlReview(plan: IntentResponse) {
  if (plan.intent === "multi_query") return true;
  if (plan.intent !== "query") return false;
  const sql = plan.sql;
  return /\bjoin\b|\/|\bover\s*\(/i.test(sql) || (sql.match(/\bselect\b/gi)?.length ?? 0) > 1;
}

export function parseSqlReview(output: string) {
  const value = parseLastJsonObject(output);
  if (!isRecord(value) || typeof value.approved !== "boolean" || !Array.isArray(value.issues) ||
    !value.issues.every((issue) => typeof issue === "string" && issue.trim())) {
    throw new Error("Model returned an invalid SQL review.");
  }
  const issues = value.issues.map((issue) => issue.trim());
  if (!value.approved && !issues.length) throw new Error("A rejected SQL review requires issues.");
  return { approved: value.approved, issues };
}

async function reviewSqlPlan(question: string, plan: IntentResponse) {
  const output = await atStage("review", 1, () => completeChat(
    [
      {
        role: "system",
        content: [
          "Independently audit a SQLite analysis plan for material semantic errors.",
          "Check the requested metric, denominator, grain, filters, date boundaries, join multiplication, and use of confirmed dataset definitions.",
          "Do not reject harmless SQL style or optimization choices.",
          "Return JSON only with approved and issues. Reject only when the answer could be materially wrong or unsupported.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          context: getSqlContext(),
          plan,
          responseShape: { approved: true, issues: ["material issue when rejected"] },
        }),
      },
    ],
    {
      maxTokens: tokenBudget("OPENAI_REVIEW_MAX_TOKENS", 2000),
      reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT"),
      temperature: 0,
      responseFormat: { type: "json_object" },
    },
  ));
  return parseSqlReview(output);
}

function parseStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function parseBrief(value: unknown, field = "brief", requireOutputs = true): AnalysisBrief {
  if (!isRecord(value)) throw new Error(`${field} is required.`);
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  const metric = typeof value.metric === "string" ? value.metric.trim() : "";
  const grain = typeof value.grain === "string" ? value.grain.trim() : "";
  if (!objective) throw new Error(`${field}.objective is required.`);
  if (!metric) throw new Error(`${field}.metric is required.`);
  if (!grain) throw new Error(`${field}.grain is required.`);
  const dimensions = parseStringArray(value.dimensions, `${field}.dimensions`);
  const outputColumns = parseStringArray(value.outputColumns, `${field}.outputColumns`);
  const filters = parseStringArray(value.filters, `${field}.filters`);
  if (requireOutputs && !outputColumns.length) throw new Error(`${field}.outputColumns cannot be empty.`);
  if (requireOutputs && dimensions.some((column) => !outputColumns.includes(column))) {
    throw new Error(`${field}.dimensions must use exact outputColumns aliases.`);
  }
  return {
    objective,
    metric,
    grain,
    dimensions,
    outputColumns,
    filters,
    ...(typeof value.comparison === "string" && value.comparison.trim()
      ? { comparison: value.comparison.trim() }
      : {}),
  };
}

export function parseSqlPlan(output: string, question: string): IntentResponse {
  const value = parseLastJsonObject(output);
  if (!isRecord(value) || typeof value.intent !== "string") {
    throw new Error("Model returned an invalid SQL plan.");
  }
  if (value.intent === "query") {
    if (typeof value.sql !== "string") throw new Error("A query intent requires SQL.");
    return {
      intent: "query",
      brief: parseBrief(value.brief),
      sql: extractSqlFromModelOutput(value.sql),
    } satisfies QueryPlan;
  }
  if (["clarification", "unsupported", "refusal"].includes(value.intent)) {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error(`${value.intent} requires a message.`);
    }
    return { intent: value.intent, message: value.message } as IntentResponse;
  }
  if (value.intent !== "multi_query" || !Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 3) {
    throw new Error("A multi-query intent requires two or three SQL steps.");
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step) || typeof step.purpose !== "string" || !step.purpose.trim() || typeof step.sql !== "string") {
      throw new Error(`steps[${index}] requires purpose and SQL.`);
    }
    return {
      kind: "query" as const,
      purpose: step.purpose.trim(),
      question: typeof step.question === "string" && step.question.trim()
        ? step.question.trim()
        : `${question}\nCalculate only: ${step.purpose.trim()}.`,
      brief: parseBrief(step.brief, `steps[${index}].brief`),
      sql: extractSqlFromModelOutput(step.sql),
    };
  });
  return {
    intent: "multi_query",
    brief: parseBrief(value.brief, "brief", false),
    steps,
  } satisfies MultiQueryPlan;
}

export async function generateSql(question: string, correction?: SqlCorrection) {
  if (correction) return generateGeneralSql(question, correction);
  const privacyRefusal = privacyRefusalForQuestion(question);
  if (privacyRefusal) return { intent: "refusal" as const, message: privacyRefusal };

  const request = (feedback?: string, attempt = 1) => atStage("sql", attempt, async () => {
    const output = await completeChat(
      [
        {
          role: "system",
          content: [
            "Translate the question into safe SQLite analysis SQL for the active dataset.",
            "Return JSON only with intent query, multi_query, clarification, unsupported, or refusal.",
            "Prefer one query whenever the requested evidence can share one result table; use two or three steps only for genuinely separate result grains.",
            "Use only supplied tables, columns, relationships, and confirmed business definitions.",
            "Create a compact analysis brief in the same response; it is an executable contract, not a separate planning step.",
            "In every brief, dimensions and outputColumns must be exact SQL output aliases; dimensions are empty only for scalar results.",
            "Preserve requested grain and filters, qualify joined columns, and prevent measure duplication across one-to-many joins.",
            "Clarify ambiguous business measures, mark unavailable data as unsupported, and refuse write, schema-control, filesystem, or raw SQL control requests.",
            "Every SQL value must be one read-only SELECT or WITH statement. Never emit INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, or multiple statements.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            question,
            context: getSqlContext(),
            responseShape: {
              intent: "query|multi_query|clarification|unsupported|refusal",
              brief: {
                objective: "decision or question being answered",
                metric: "business measure or record set",
                grain: "one row per what",
                dimensions: ["exact grouping output alias; empty for scalar"],
                outputColumns: ["every required SQL output alias"],
                filters: ["explicit filter or boundary; empty when none"],
                comparison: "optional comparison basis",
              },
              sql: "required for query",
              steps: [{
                purpose: "short label",
                question: "self-contained sub-question",
                brief: "same brief shape, scoped to this step",
                sql: "SELECT ...",
              }],
              message: "required for clarification, unsupported, or refusal",
            },
          }),
        },
        ...(feedback
          ? [{ role: "user" as const, content: `Return a corrected full JSON plan. Independent validation found: ${feedback}` }]
          : []),
      ],
      {
        maxTokens: tokenBudget("OPENAI_SQL_MAX_TOKENS", 4096),
        reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT", Boolean(feedback)),
        temperature: 0,
        responseFormat: { type: "json_object" },
      },
    );
    return parseSqlPlan(output, question);
  });

  let plan: IntentResponse;
  try {
    plan = await request();
  } catch (error) {
    plan = await request(error instanceof Error ? error.message : "Invalid SQL plan.", 2);
  }
  if (!needsSqlReview(plan)) return plan;
  let review: Awaited<ReturnType<typeof reviewSqlPlan>>;
  try {
    review = await reviewSqlPlan(question, plan);
  } catch (error) {
    return {
      ...plan,
      review: {
        decision: "unavailable" as const,
        issues: [error instanceof Error ? error.message : String(error)],
      },
    };
  }
  if (review.approved) {
    return { ...plan, review: { decision: "approved" as const, issues: [] } };
  }
  const repaired = await request(review.issues.join(" "), 2);
  return repaired.intent === "query" || repaired.intent === "multi_query"
    ? { ...repaired, review: { decision: "repaired" as const, issues: review.issues } }
    : repaired;
}

export async function generateGeneralSql(question: string, correction?: SqlCorrection) {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Generate one SQLite read-only SELECT query for the active dataset.",
        "Return only SQL without markdown, JSON, explanations, or comments.",
        "Use only supplied tables, columns, relationships, and business definitions.",
        "Match the requested result grain and preserve every explicit filter.",
        "Qualify columns in multi-table queries and prevent measure duplication across one-to-many joins.",
        "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, or multiple statements.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        getSqlContext(),
        `Question and requirement:\n${question}`,
        ...(correction?.brief
          ? [`Analysis brief that the repaired SQL must satisfy:\n${JSON.stringify(correction.brief)}`]
          : []),
        ...(correction
          ? [
              `Previous SQL failed:\n${correction.sql}`,
              `SQLite error: ${correction.error}`,
              "Repair the SQL without changing its measure, grain, or filters.",
            ]
          : []),
      ].join("\n\n"),
    },
  ];
  const output = await atStage("sql", correction?.attempt ?? 1, () => completeChat(messages, {
    maxTokens: tokenBudget("OPENAI_SQL_MAX_TOKENS", 4096),
    reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT", Boolean(correction)),
    temperature: 0,
  }));
  return extractSqlFromModelOutput(output);
}
