import { getSchemaText } from "./schema";
import { DATASET_IDS, getDatasetGuide } from "./datasetGuide";
import {
  completeChat,
  completeChatMessage,
  type ChatMessage,
  type ChatTool,
  type ToolCall,
} from "./llmClient";
import { extractSqlFromModelOutput } from "./sqlExtraction";
import { withDefaultLimit } from "./sqlSafety";

const DATASET_GUIDE_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "get_dataset_guide",
    description:
      "Load trusted table relationships, metric definitions, and join cautions for a registered dataset.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["dataset"],
      properties: {
        dataset: { type: "string", enum: DATASET_IDS },
      },
    },
  },
};

export function executeDatasetGuideTool(call: ToolCall) {
  if (call.function.name !== "get_dataset_guide") {
    throw new Error(`Unsupported tool: ${call.function.name}`);
  }

  let args: unknown = call.function.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      throw new Error("Model returned invalid tool arguments.");
    }
  }
  const dataset = (args as { dataset?: unknown })?.dataset;
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    typeof dataset !== "string" ||
    !DATASET_IDS.includes(dataset)
  ) {
    throw new Error("Model requested an unknown dataset.");
  }
  return getDatasetGuide(dataset);
}

export function selectDatasetGuideCall(calls: ToolCall[]) {
  if (calls.length > 1) {
    throw new Error("Model requested more than one dataset guide.");
  }
  return (
    calls[0] ?? {
      id: "dataset-guide",
      type: "function" as const,
      function: {
        name: "get_dataset_guide",
        arguments: { dataset: "olist" },
      },
    }
  );
}

export type SqlCorrection = { sql: string; error: string };

export async function generateSql(
  question: string,
  correction?: SqlCorrection,
) {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You generate SQLite SELECT queries for ecommerce analytics.",
        "First call get_dataset_guide exactly once, then use its content to generate SQL.",
        "Questions can be written in English or Vietnamese; translate the user intent internally.",
        "After the tool result, return only SQL without markdown, JSON, explanations, or comments.",
        "The SQL must answer the exact current user question and be one read-only SELECT statement.",
        "Use only tables and columns from the schema.",
        "Cast numeric CSV text fields with CAST(column AS REAL) before math.",
        "CSV missing values are empty strings; exclude them when grouping dates or numbers.",
        "Use explicit JOINs instead of correlated subqueries.",
        "When joining tables, qualify every column with its table alias.",
        "For rankings, select only the requested label or ID, metric, and a sample count.",
        "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, or multiple statements.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Schema:\n${getSchemaText()}`,
        `Question: ${question}`,
        ...(correction
          ? [
              `Previous SQL failed:\n${correction.sql}`,
              `SQLite error: ${correction.error}`,
              "Repair the SQL without changing the requested metric.",
            ]
          : []),
      ].join("\n\n"),
    },
  ];
  const toolResponse = await completeChatMessage(messages, {
    maxTokens: 80,
    temperature: 0,
    tools: [DATASET_GUIDE_TOOL],
    toolChoice: "required",
  });
  const calls = toolResponse?.tool_calls ?? [];
  const call = selectDatasetGuideCall(calls);
  const output = await completeChat(
    [
      ...messages,
      {
        role: "assistant",
        content: calls.length ? toolResponse?.content ?? null : null,
        tool_calls: [call],
      },
      {
        role: "tool",
        content: executeDatasetGuideTool(call),
        tool_call_id: call.id,
      },
      {
        role: "user",
        content: [
          "Now return only the final SQL query.",
          "Use short table aliases and qualify every column in SELECT, JOIN, WHERE, GROUP BY, HAVING, and ORDER BY.",
          ...(correction
            ? [`The previous query failed with: ${correction.error}`]
            : []),
        ].join(" "),
      },
    ],
    {
      maxTokens: 320,
      temperature: 0,
      tools: [DATASET_GUIDE_TOOL],
      toolChoice: "none",
    },
  );

  return withDefaultLimit(extractSqlFromModelOutput(output));
}
