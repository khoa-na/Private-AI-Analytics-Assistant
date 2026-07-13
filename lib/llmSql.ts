import { getDatasetGuide } from "./datasetGuide";
import { completeChat, stageReasoningEffort, tokenBudget, type ChatMessage } from "./llmClient";
import { tryGenerateQueryPlan } from "./llmQueryPlan";
import { getSchemaText } from "./schema";
import { extractSqlFromModelOutput } from "./sqlExtraction";
import { atStage } from "./pipelineError";

export type SqlCorrection = { sql: string; error: string; attempt?: number };

export function getSqlContext() {
  return `Schema:\n${getSchemaText()}\n\nDataset semantics:\n${getDatasetGuide()}`;
}

export async function generateSql(question: string, correction?: SqlCorrection) {
  if (!correction) {
    const plan = await tryGenerateQueryPlan(question);
    if (plan) return plan;
  }
  return generateGeneralSql(question, correction);
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
        "Ask no questions here; ambiguity is handled by the planner.",
        "Never write INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, or multiple statements.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        getSqlContext(),
        `Question and requirement:\n${question}`,
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
  const output = await atStage("sql", correction?.attempt ?? (correction ? 2 : 1), () => completeChat(messages, {
    maxTokens: tokenBudget("OPENAI_SQL_MAX_TOKENS", 4096),
    reasoningEffort: stageReasoningEffort("OPENAI_SQL_REASONING_EFFORT", Boolean(correction)),
    temperature: 0,
  }));
  return extractSqlFromModelOutput(output);
}
