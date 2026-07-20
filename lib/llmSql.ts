import { getDatasetGuide, getSemanticClarification } from "./datasetGuide";
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

export async function getSqlContext() {
  return `Schema:\n${await getSchemaText()}\n\nDataset semantics:\n${getDatasetGuide()}`;
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
  const context = await getSqlContext();
  const output = await atStage("review", 1, () => completeChat(
    [
      {
        role: "system",
        content: [
          "Independently audit a DuckDB analysis plan for material semantic errors.",
          "Check the requested metric, denominator, grain, filters, date boundaries, join multiplication, and use of confirmed dataset definitions.",
          "Do not reject harmless SQL style or optimization choices.",
          "Return JSON only with approved and issues. Reject only when the answer could be materially wrong or unsupported.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          context,
          question,
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

function parseOptionalStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function parseBrief(value: unknown, field = "brief", requireOutputs = true): AnalysisBrief {
  if (!isRecord(value)) throw new Error(`${field} is required.`);
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  const metric = typeof value.metric === "string" ? value.metric.trim() : "";
  const grain = typeof value.grain === "string" ? value.grain.trim() : "";
  if (!objective) throw new Error(`${field}.objective is required.`);
  if (!metric) throw new Error(`${field}.metric is required.`);
  if (!grain) throw new Error(`${field}.grain is required.`);
  const dimensions = parseStringArray(value.dimensions ?? [], `${field}.dimensions`);
  const outputColumns = parseStringArray(value.outputColumns, `${field}.outputColumns`);
  const filters = parseOptionalStringArray(value.filters);
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
      ...(step.brief === undefined ? {} : { brief: parseBrief(step.brief, `steps[${index}].brief`) }),
      sql: extractSqlFromModelOutput(step.sql),
    };
  });
  return {
    intent: "multi_query",
    ...(value.brief === undefined ? {} : { brief: parseBrief(value.brief, "brief", false) }),
    steps,
  } satisfies MultiQueryPlan;
}

export function parseMultiOutline(output: string) {
  const value = parseLastJsonObject(output);
  if (!isRecord(value) || !Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 3) {
    throw new Error("A multi-query outline requires two or three steps.");
  }
  return value.steps.map((step, index) => {
    if (!isRecord(step) || typeof step.purpose !== "string" || !step.purpose.trim() ||
      typeof step.question !== "string" || !step.question.trim()) {
      throw new Error(`outline.steps[${index}] requires purpose and question.`);
    }
    return { purpose: step.purpose.trim(), question: step.question.trim() };
  });
}

export function shouldFallbackToOutline(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /token budget|json|sql plan|\bbrief\b|\bsteps?\b|requires|must be|cannot be empty/i.test(message);
}

export function prefersSingleQueryFallback(question: string) {
  return /\breturn\b|trả về/i.test(question) &&
    !/\b(?:independent|separate)\s+(?:queries|audits?|audit\s+queries|evidence|analyses)\b|(?:audit|truy vấn)[^.;\n]*độc lập/i.test(question);
}

function completeClarification(question: string, plan: IntentResponse): IntentResponse {
  if (plan.intent !== "clarification" || !/\b(?:best|top|performed|performance)\b|tốt nhất|hiệu quả nhất/i.test(question) ||
    /\b(?:period|time|date)\b|thời gian|giai đoạn|ngày|tháng|năm/i.test(plan.message)) return plan;
  return { ...plan, message: `${plan.message} What time period should the comparison cover?` };
}

export function causalUnsupportedForQuestion(question: string) {
  if (!/\b(?:cause[ds]?|causal(?:ity)?|caused by)\b|gây ra|nhân quả|khiến cho/i.test(question)) {
    return undefined;
  }
  return "This observational dataset can measure associations, but it cannot determine causality. A causal claim requires an appropriate experiment or causal identification design, and any business measure must also have a confirmed definition.";
}

async function generateSingleQueryPlan(question: string) {
  const context = await getSqlContext();
  const output = await atStage("sql", 1, () => completeChat([
    {
      role: "system",
      content: [
        "Generate exactly one DuckDB evidence query and its executable analysis brief.",
        "Return JSON only with brief and sql. Do not decompose, clarify, or analyze.",
        "Use only supplied tables, columns, relationships, and confirmed definitions.",
        "The brief dimensions and outputColumns must be exact SQL output aliases.",
        "Preserve requested grain and filters and emit one read-only SELECT or WITH statement.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        context,
        question,
        responseShape: {
          brief: {
            objective: "question being answered",
            metric: "measure or record set",
            grain: "one row per what",
            dimensions: ["exact grouping output alias"],
            outputColumns: ["every SQL output alias"],
            filters: ["explicit filter or boundary"],
          },
          sql: "one SELECT or WITH query",
        },
      }),
    },
  ], {
    maxTokens: tokenBudget("OPENAI_STEP_MAX_TOKENS", 6144),
    reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT"),
    temperature: 0,
    responseFormat: { type: "json_object" },
  }));
  const value = parseLastJsonObject(output);
  if (!isRecord(value) || typeof value.sql !== "string") {
    throw new Error("Single evidence step requires brief and SQL.");
  }
  return { brief: parseBrief(value.brief), sql: extractSqlFromModelOutput(value.sql) };
}

async function generateOutlinedPlan(question: string): Promise<MultiQueryPlan> {
  const output = await atStage("sql", 3, () => completeChat([
    {
      role: "system",
      content: "Decompose one analytical request into two or three independent evidence questions. Return JSON only with steps containing purpose and self-contained question. Do not write SQL or analysis.",
    },
    { role: "user", content: JSON.stringify({ question, responseShape: { steps: [{ purpose: "short label", question: "self-contained evidence question" }] } }) },
  ], {
    maxTokens: tokenBudget("OPENAI_PLAN_MAX_TOKENS", 1200),
    reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT"),
    temperature: 0,
    responseFormat: { type: "json_object" },
  }));
  const outline = parseMultiOutline(output);
  const steps = await Promise.all(outline.map(async (step) => {
    const scopedQuestion = [
      `Evidence view: ${step.purpose}`,
      `Sub-question: ${step.question}`,
      `Parent request definitions and constraints: ${question}`,
      "Generate only this evidence view.",
    ].join("\n");
    let single = await generateSingleQueryPlan(scopedQuestion);
    try {
      const review = await reviewSqlPlan(scopedQuestion, { intent: "query", ...single });
      if (!review.approved) {
        single = await generateSingleQueryPlan(`${scopedQuestion}\nIndependent review found: ${review.issues.join(" ")}`);
      }
    } catch {
      // Review is a quality layer; an unavailable reviewer must not discard an executable step.
    }
    return { kind: "query" as const, ...step, ...single };
  }));
  return { intent: "multi_query", steps };
}

export async function generateSql(question: string, correction?: SqlCorrection) {
  if (correction) return generateGeneralSql(question, correction);
  const privacyRefusal = privacyRefusalForQuestion(question);
  if (privacyRefusal) return { intent: "refusal" as const, message: privacyRefusal };
  const causalUnsupported = causalUnsupportedForQuestion(question);
  if (causalUnsupported) return { intent: "unsupported" as const, message: causalUnsupported };
  const semanticClarification = getSemanticClarification(question);
  if (semanticClarification) return { intent: "clarification" as const, message: semanticClarification };

  const request = (feedback?: string, attempt = 1) => atStage("sql", attempt, async () => {
    const output = await completeChat(
      [
        {
          role: "system",
          content: [
            "Translate the question into safe DuckDB analysis SQL for the active dataset.",
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
            context: await getSqlContext(),
            question,
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
  } catch (firstError) {
    try {
      plan = await request(firstError instanceof Error ? firstError.message : "Invalid SQL plan.", 2);
    } catch (secondError) {
      if (!shouldFallbackToOutline(secondError)) throw secondError;
      if (prefersSingleQueryFallback(question)) {
        try {
          plan = { intent: "query", ...await generateSingleQueryPlan(question) };
        } catch {
          return generateOutlinedPlan(question);
        }
      } else {
        return generateOutlinedPlan(question);
      }
    }
  }
  plan = completeClarification(question, plan);
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
  try {
    const repaired = completeClarification(question, await request(review.issues.join(" "), 2));
    return repaired.intent === "query" || repaired.intent === "multi_query"
      ? { ...repaired, review: { decision: "repaired" as const, issues: review.issues } }
      : repaired;
  } catch (error) {
    if (plan.intent !== "query") throw error;
    const sql = await generateGeneralSql(question, {
      sql: plan.sql,
      error: review.issues.join(" "),
      attempt: 2,
      brief: plan.brief,
    });
    return { ...plan, sql, review: { decision: "repaired" as const, issues: review.issues } };
  }
}

export async function generateGeneralSql(question: string, correction?: SqlCorrection) {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Generate one DuckDB read-only SELECT query for the active dataset.",
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
        await getSqlContext(),
        `Question and requirement:\n${question}`,
        ...(correction?.brief
          ? [`Analysis brief that the repaired SQL must satisfy:\n${JSON.stringify(correction.brief)}`]
          : []),
        ...(correction
          ? [
              `Previous SQL failed:\n${correction.sql}`,
              `DuckDB error: ${correction.error}`,
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
