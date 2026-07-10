import type { Analysis, ChartSpec, ResultProfile, Row } from "./analyticsTypes";
import { completeChat } from "./llmClient";

type AnalysisResult = {
  analysis: Analysis;
  chart: ChartSpec;
  followUpQuestions: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function evidenceFromRows(rows: Row[]) {
  return new Set(
    rows.flatMap((row) =>
      Object.entries(row).map(([column, value]) => `${column} = ${String(value)}`),
    ),
  );
}

export function parseAnalysis(
  output: string,
  columns: string[],
  allowedEvidence: Set<string>,
  numericColumns = columns,
): AnalysisResult {
  const json = output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Model returned invalid analysis JSON.");
  }

  if (!isRecord(value) || !isRecord(value.analysis) || !isRecord(value.chart)) {
    throw new Error("Model returned an invalid analysis structure.");
  }

  const { analysis, chart, followUpQuestions } = value;
  const insights = analysis.insights;
  const caveats = analysis.caveats;
  if (
    typeof analysis.summary !== "string" ||
    !Array.isArray(insights) ||
    !Array.isArray(caveats) ||
    !caveats.every((item) => typeof item === "string") ||
    !Array.isArray(followUpQuestions) ||
    !followUpQuestions.every((item) => typeof item === "string")
  ) {
    throw new Error("Model returned an invalid analysis structure.");
  }

  const parsedInsights = insights.map((insight) => {
    if (
      !isRecord(insight) ||
      typeof insight.statement !== "string" ||
      !Array.isArray(insight.evidence) ||
      insight.evidence.length === 0 ||
      !insight.evidence.every(
        (item) => typeof item === "string" && allowedEvidence.has(item),
      )
    ) {
      throw new Error("Model returned an insight without supported evidence.");
    }
    return insight as { statement: string; evidence: string[] };
  });

  const chartType = String(chart.type);
  const validAxes =
    chartType === "none" ||
    (typeof chart.xKey === "string" &&
      columns.includes(chart.xKey) &&
      Array.isArray(chart.yKeys) &&
      chart.yKeys.length === 1 &&
      typeof chart.yKeys[0] === "string" &&
      numericColumns.includes(chart.yKeys[0]));
  if (
    !["bar", "line", "none"].includes(chartType) ||
    typeof chart.reason !== "string" ||
    !chart.reason.trim() ||
    !validAxes
  ) {
    throw new Error("Model returned an invalid chart specification.");
  }

  return {
    analysis: {
      summary: analysis.summary,
      insights: parsedInsights,
      caveats: caveats as string[],
    },
    chart: chart as ChartSpec,
    followUpQuestions: followUpQuestions as string[],
  };
}

export async function analyzeResult(
  question: string,
  sql: string,
  profile: ResultProfile,
) {
  if (!profile.rowCount) {
    return {
      analysis: {
        summary: "The query returned no data.",
        insights: [],
        caveats: ["There is no evidence available for this question."],
      },
      chart: {
        type: "none" as const,
        reason: "The query returned no data to visualize.",
      },
      followUpQuestions: [],
    };
  }

  const allowedEvidence = evidenceFromRows(profile.sampleRows);
  const columns = profile.columns.map(({ name }) => name);
  const numericColumns = profile.columns
    .filter(({ type }) => type === "number")
    .map(({ name }) => name);
  const output = await completeChat(
    [
      {
        role: "system",
        content: [
          "You are a grounded ecommerce data analyst.",
          "Return only valid JSON with analysis, chart, and followUpQuestions.",
          "Every insight needs at least one evidence string copied exactly from allowedEvidence.",
          "Do not state numbers that are not present in the evidence.",
          "You must recommend a chart type: bar, line, or none.",
          "For bar or line, choose one xKey and exactly one numeric yKey from the returned columns.",
          "Choose none when a chart would not improve understanding. Include a concise reason.",
          "Keep the response concise and answer in the language of the question.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          sql,
          profile: {
            rowCount: profile.rowCount,
            truncated: profile.truncated,
            columns: profile.columns,
          },
          allowedEvidence: [...allowedEvidence],
          responseShape: {
            analysis: {
              summary: "string",
              insights: [{ statement: "string", evidence: ["column = value"] }],
              caveats: ["string"],
            },
            chart: {
              type: "bar|line|none",
              reason: "string",
              xKey: "column",
              yKeys: ["one numeric column"],
            },
            followUpQuestions: ["string"],
          },
        }),
      },
    ],
    {
      maxTokens: 700,
      temperature: 0.1,
      responseFormat: {
        type: "json_object",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["analysis", "chart", "followUpQuestions"],
          properties: {
            analysis: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "insights", "caveats"],
              properties: {
                summary: { type: "string" },
                insights: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["statement", "evidence"],
                    properties: {
                      statement: { type: "string" },
                      evidence: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", enum: [...allowedEvidence] },
                      },
                    },
                  },
                },
                caveats: { type: "array", items: { type: "string" } },
              },
            },
            chart: {
              type: "object",
              additionalProperties: false,
              required: ["type", "reason"],
              properties: {
                type: { type: "string", enum: ["bar", "line", "none"] },
                reason: { type: "string" },
                xKey: { type: "string", enum: columns },
                yKeys: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: {
                    type: "string",
                    enum: numericColumns.length ? numericColumns : columns,
                  },
                },
              },
            },
            followUpQuestions: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
  );

  return parseAnalysis(output, columns, allowedEvidence, numericColumns);
}
