import { getDatasetGuide } from "./datasetGuide";
import { completeChat, stageReasoningEffort, tokenBudget } from "./llmClient";
import type { IntentResponse, MultiQueryPlan } from "./queryPlan";
import { getSchemaText } from "./schema";
import { parseLastJsonObject } from "./jsonOutput";
import { atStage, PipelineStageError } from "./pipelineError";

type Requirement = {
  measure: string;
  definition?: string;
  grain: string[];
  filters: string[];
};

export class AnalysisPlanError extends PipelineStageError {
  constructor(message: string, readonly outputs: string[]) {
    super("plan", message.replace(/^\[plan:\d+\]\s*/, ""), 2);
    this.name = "AnalysisPlanError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAnalysisPlan(
  output: string,
  question: string,
): IntentResponse | undefined {
  let value: Record<string, unknown>;
  try {
    value = parseLastJsonObject(output);
  } catch {
    throw new Error("Model returned invalid analysis plan JSON.");
  }
  if (typeof value.intent !== "string") {
    throw new Error("Model returned an invalid analysis plan.");
  }
  if (["clarification", "unsupported", "refusal"].includes(value.intent)) {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error("Analysis plan message is required.");
    }
    return value as IntentResponse;
  }
  const rawRequirements = Array.isArray(value.requirements)
    ? value.requirements
    : isRecord(value.requirements) ? [value.requirements] : [];
  if (!["analysis", "query"].includes(value.intent) || !rawRequirements.length) {
    throw new Error("Analysis requirements are required.");
  }

  const typed = rawRequirements.map((item, index): Requirement => {
    if (!isRecord(item)) throw new Error(`requirements[${index}] must be an object.`);
    const legacyMeasure = isRecord(item.measure) ? item.measure : undefined;
    const measure = typeof item.measure === "string"
      ? item.measure
      : legacyMeasure?.name ?? item.metric;
    const definition = typeof item.definition === "string"
      ? item.definition
      : typeof legacyMeasure?.definition === "string" ? legacyMeasure.definition : undefined;
    if (typeof measure !== "string" || !measure.trim()) {
      throw new Error(`requirements[${index}].measure must be a non-empty string.`);
    }
    const normalizeList = (key: "grain" | "filters") => {
      const value = item[key] ?? (key === "grain" ? item.dimensions : undefined) ?? [];
      const list = typeof value === "string" ? [value] : value;
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string" && entry.trim())) {
        throw new Error(`requirements[${index}].${key} must be an array of strings.`);
      }
      return list as string[];
    };
    return {
      measure: measure.trim(),
      ...(definition?.trim() ? { definition: definition.trim() } : {}),
      grain: normalizeList("grain"),
      filters: normalizeList("filters"),
    };
  });
  const groups = new Map<string, Requirement[]>();
  for (const requirement of typed) {
    const key = JSON.stringify({
      grain: [...requirement.grain].sort(),
      filters: [...requirement.filters].sort(),
    });
    groups.set(key, [...(groups.get(key) ?? []), requirement]);
  }
  if (groups.size === 1) return;
  if (groups.size > 3) throw new Error("Analysis requires more than three query steps.");

  return {
    intent: "multi_query",
    steps: [...groups.values()].map((items) => ({
      kind: "query" as const,
      purpose: items.map(({ measure }) => measure).join(" and "),
      question: [
        question,
        `Calculate only: ${items.map(({ measure, definition }) =>
          definition ? `${measure} (${definition})` : measure).join("; ")}.`,
      ].join(" "),
      requiredGrain: items[0].grain.join(", ") || "one scalar row",
      filters: items[0].filters,
    })),
  } satisfies MultiQueryPlan;
}

export async function tryGenerateQueryPlan(question: string) {
  const request = (correction?: string) => completeChat(
    [
      {
        role: "system",
        content: [
          "Extract open analytics requirements from the question using only the supplied active-dataset context.",
          "Dataset analysis_policy entries are authoritative for ambiguity, unsupported requests, and default comparison rules.",
          "Return intent=analysis for answerable analytics. Name each measure without relying on a fixed metric catalog; add an optional definition only when the context defines it.",
          "A grain is the entity represented by one result row. Measures with the same grain and filters can share one query.",
          "Use clarification when a business measure or requested entity is ambiguous, unsupported when the schema lacks required data, and refusal for write, schema-control, filesystem, or raw SQL control requests.",
          "Do not invent columns, relationships, product names, or business definitions absent from the context.",
          "Copy all explicit time and entity filters into every affected requirement.",
          "For qualitative comparisons such as high, low, weak, or strong, return the underlying ranked measures; synthesis will compare them. Do not request arbitrary thresholds unless the user explicitly asks for threshold filtering.",
          "Qualitative ranking is allowed only when the measure is explicit or defined by dataset policy. Words such as best, performance, strong, or weak without a measure require clarification.",
          "Forecasting is unsupported unless the dataset semantics specifies a forecasting method.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          schema: getSchemaText(),
          semantics: getDatasetGuide(),
          responseShape: {
            intent: "analysis|clarification|unsupported|refusal",
            requirements: [{
              measure: "string",
              definition: "optional string",
              grain: ["column or logical entity"],
              filters: ["explicit filter"],
            }],
            message: "required unless intent=analysis",
          },
        }),
      },
      ...(correction
        ? [{ role: "user" as const, content: `Your previous plan was invalid: ${correction} Return corrected JSON.` }]
        : []),
    ],
    {
      maxTokens: tokenBudget("OPENAI_PLAN_MAX_TOKENS", 2400),
      reasoningEffort: stageReasoningEffort("OPENAI_PLAN_REASONING_EFFORT", Boolean(correction)),
      temperature: 0,
      responseFormat: { type: "json_object" },
    },
  );

  const outputs: string[] = [];
  try {
    const output = await atStage("plan", 1, () => request());
    outputs.push(output);
    return parseAnalysisPlan(output, question);
  } catch (firstError) {
    const reason = firstError instanceof Error ? firstError.message : "Invalid analysis plan.";
    try {
      const output = await atStage("plan", 2, () => request(reason));
      outputs.push(output);
      return parseAnalysisPlan(output, question);
    } catch (secondError) {
      throw new AnalysisPlanError(
        secondError instanceof Error ? secondError.message : "Invalid analysis plan.",
        outputs,
      );
    }
  }
}
