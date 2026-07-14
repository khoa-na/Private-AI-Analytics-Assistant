import type { Analysis, ChartSpec, ResultProfile, Row } from "./analyticsTypes";
import { getDatasetGuide } from "./datasetGuide";
import { completeChat, stageReasoningEffort, tokenBudget } from "./llmClient";
import { parseLastJsonObject } from "./jsonOutput";
import { atStage } from "./pipelineError";

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
  allowedCaveats: string[] = [],
): AnalysisResult {
  let value: unknown;
  try {
    value = parseLastJsonObject(output);
  } catch {
    throw new Error("Model returned invalid analysis JSON.");
  }

  if (!isRecord(value) || !isRecord(value.analysis)) {
    throw new Error("Model returned an invalid analysis structure.");
  }

  const { analysis, chart, followUpQuestions } = value;
  const insights = analysis.insights;
  const caveats = analysis.caveats;
  const summaryEvidence = analysis.summaryEvidence;
  if (
    typeof analysis.summary !== "string" ||
    !Array.isArray(summaryEvidence) ||
    summaryEvidence.length === 0 ||
    !summaryEvidence.every(
      (item) => typeof item === "string" && allowedEvidence.has(item),
    ) ||
    !Array.isArray(insights) ||
    !Array.isArray(caveats) ||
    !caveats.every(
      (item) => typeof item === "string" && allowedCaveats.includes(item),
    )
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

  const chartType = isRecord(chart) ? String(chart.type) : "";
  const validAxes =
    chartType === "none" ||
    (isRecord(chart) &&
      typeof chart.xKey === "string" &&
      columns.includes(chart.xKey) &&
      Array.isArray(chart.yKeys) &&
      chart.yKeys.length === 1 &&
      typeof chart.yKeys[0] === "string" &&
      numericColumns.includes(chart.yKeys[0]));
  const validChart =
    isRecord(chart) &&
    ["bar", "line", "none"].includes(chartType) &&
    typeof chart.reason === "string" &&
    chart.reason.trim() &&
    validAxes;

  return {
    analysis: {
      summary: analysis.summary,
      summaryEvidence: summaryEvidence as string[],
      insights: parsedInsights,
      caveats: caveats as string[],
    },
    chart: validChart
      ? chart as ChartSpec
      : { type: "none", reason: "Model returned an invalid chart specification." },
    followUpQuestions: Array.isArray(followUpQuestions) &&
      followUpQuestions.every((item) => typeof item === "string")
      ? followUpQuestions
      : [],
  };
}

export async function parseAnalysisWithOneRetry(
  request: (correction?: string) => Promise<string>,
  columns: string[],
  allowedEvidence: Set<string>,
  numericColumns = columns,
  allowedCaveats: string[] = [],
) {
  try {
    return parseAnalysis(
      await request(),
      columns,
      allowedEvidence,
      numericColumns,
      allowedCaveats,
    );
  } catch (firstError) {
    try {
      return parseAnalysis(
        await request(firstError instanceof Error ? firstError.message : "Invalid analysis output."),
        columns,
        allowedEvidence,
        numericColumns,
        allowedCaveats,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Analysis failed.";
      return {
        analysis: {
          summary: "The query succeeded, but the model analysis was unavailable.",
          summaryEvidence: [],
          insights: [],
          caveats: [reason],
        },
        chart: {
          type: "none" as const,
          reason: "No validated analysis was available for a chart recommendation.",
        },
        followUpQuestions: [],
      };
    }
  }
}

function samplingCaveat(profile: ResultProfile) {
  return profile.sampleRows.length < profile.rowCount
    ? `Analysis evidence samples ${profile.sampleRows.length} of ${profile.rowCount} returned rows.`
    : undefined;
}

function caveatsFromProfile(profile: ResultProfile) {
  const sampling = samplingCaveat(profile);
  return [
    ...(profile.truncated ? ["Results were limited to 1000 rows."] : []),
    ...(sampling ? [sampling] : []),
    ...profile.columns
      .filter(({ nullCount }) => nullCount > 0)
      .map(({ name, nullCount }) => `${name} contains ${nullCount} null values.`),
  ];
}

function evidenceFromRow(row: Row) {
  return Object.entries(row).map(([column, value]) => `${column} = ${String(value)}`);
}

export function deterministicAnalysis(
  question: string,
  sql: string,
  profile: ResultProfile,
): AnalysisResult | undefined {
  if (!profile.rowCount) return;

  const vietnamese = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i.test(question);
  const caveats = caveatsFromProfile(profile);
  const first = profile.sampleRows[0];
  const columns = profile.columns.map(({ name }) => name);
  const numeric = profile.columns.filter(({ type }) => type === "number").map(({ name }) => name);

  if (profile.rowCount === 1) {
    const evidence = evidenceFromRow(first);
    return {
      analysis: {
        summary: `${vietnamese ? "Kết quả" : "Result"}: ${evidence.join(", ")}.`,
        summaryEvidence: evidence,
        insights: [],
        caveats,
      },
      chart: {
        type: "none",
        reason: vietnamese
          ? "Một giá trị đơn không cần biểu đồ."
          : "A single value does not need a chart.",
      },
      followUpQuestions: [],
    };
  }

  const requestedLimit = Number(sql.match(/\blimit\s+(\d+)\s*$/i)?.[1]);
  const ranking = requestedLimit > 0 && requestedLimit < 1000 && /\border\s+by\b/i.test(sql);
  if (ranking) {
    const label = columns.find((column) => !numeric.includes(column)) ?? columns[0];
    const metric = numeric[0];
    const evidence = [label, metric].filter(Boolean).map((column) => `${column} = ${String(first[column])}`);
    return {
      analysis: {
        summary: vietnamese
          ? `Kết quả xếp hạng có ${profile.rowCount} dòng; dòng đầu là ${evidence.join(", ")}.`
          : `The ranking has ${profile.rowCount} rows; the first is ${evidence.join(", ")}.`,
        summaryEvidence: evidence,
        insights: [],
        caveats,
      },
      chart: metric
        ? {
            type: "bar",
            reason: vietnamese ? "Biểu đồ cột phù hợp với kết quả xếp hạng." : "A bar chart fits ranked results.",
            xKey: label,
            yKeys: [metric],
          }
        : { type: "none", reason: "The ranking has no numeric metric to chart." },
      followUpQuestions: [],
    };
  }

  const timeColumns = columns.filter((column) => /(?:^|_)(?:year|month|date|time)(?:_|$)/i.test(column));
  if (timeColumns.length) {
    const evidence = timeColumns.map((column) => `${column} = ${String(first[column])}`);
    const yKey = numeric.find((column) => !timeColumns.includes(column));
    return {
      analysis: {
        summary: vietnamese
          ? `Chuỗi thời gian trả về ${profile.rowCount} điểm dữ liệu.`
          : `The time series returned ${profile.rowCount} data points.`,
        summaryEvidence: evidence,
        insights: [],
        caveats,
      },
      chart:
        timeColumns.length === 1 && yKey
          ? {
              type: "line",
              reason: vietnamese ? "Biểu đồ đường phù hợp với chuỗi thời gian." : "A line chart fits a time series.",
              xKey: timeColumns[0],
              yKeys: [yKey],
            }
          : {
              type: "none",
              reason: vietnamese
                ? "Biểu đồ hiện tại không hỗ trợ nhiều chiều thời gian."
                : "The current chart does not support multiple time dimensions.",
            },
      followUpQuestions: [],
    };
  }
}

export async function analyzeResult(
  question: string,
  sql: string,
  profile: ResultProfile,
  useDeterministic = true,
) {
  if (!profile.rowCount) {
    return {
      analysis: {
        summary: "The query returned no data.",
        summaryEvidence: [],
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
  const deterministic = useDeterministic
    ? deterministicAnalysis(question, sql, profile)
    : undefined;
  const sampling = samplingCaveat(profile);
  if (deterministic) return deterministic;

  const allowedCaveats = caveatsFromProfile(profile);
  const columns = profile.columns.map(({ name }) => name);
  const numericColumns = profile.columns
    .filter(({ type }) => type === "number")
    .map(({ name }) => name);
  const requestAnalysis = (correction?: string) => atStage(
    "analysis",
    correction ? 2 : 1,
    () => completeChat(
    [
      {
        role: "system",
        content: [
          "You are a grounded data analyst.",
          "Return only valid JSON with analysis, chart, and followUpQuestions.",
          "Every insight needs at least one evidence string copied exactly from allowedEvidence.",
          "The summary needs at least one summaryEvidence string copied exactly from allowedEvidence.",
          "When the summary says highest or lowest, copy both the exact entity label and metric value into summaryEvidence.",
          "Every caveat must be copied exactly from allowedCaveats. Return no caveats when allowedCaveats is empty.",
          "Profile column statistics cover all returned rows; allowedEvidence is a representative sample when sampledRows is smaller than rowCount.",
          "Do not claim exhaustive entity coverage from sampled evidence, and include the sampling caveat when one is allowed.",
          "Numbers must come from evidence or profile statistics, but may be rounded or expressed as percentages or standard magnitude units.",
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
          semantics: getDatasetGuide(),
          profile: {
            rowCount: profile.rowCount,
            sampledRows: profile.sampleRows.length,
            truncated: profile.truncated,
            columns: profile.columns,
          },
          allowedEvidence: [...allowedEvidence],
          allowedCaveats,
          responseShape: {
            analysis: {
              summary: "string",
              summaryEvidence: ["column = value"],
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
      ...(correction
        ? [{
            role: "user" as const,
            content: `Your previous analysis was invalid: ${correction} Return corrected JSON using only the supplied evidence and schema.`,
          }]
        : []),
    ],
    {
      maxTokens: tokenBudget("OPENAI_ANALYSIS_MAX_TOKENS", 2400),
      reasoningEffort: stageReasoningEffort("OPENAI_ANALYSIS_REASONING_EFFORT", Boolean(correction)),
      temperature: 0,
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
              required: ["summary", "summaryEvidence", "insights", "caveats"],
              properties: {
                summary: { type: "string" },
                summaryEvidence: {
                  type: "array",
                  minItems: 1,
                  maxItems: 2,
                  items: { type: "string", enum: [...allowedEvidence] },
                },
                insights: {
                  type: "array",
                  maxItems: 3,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["statement", "evidence"],
                    properties: {
                      statement: { type: "string" },
                      evidence: {
                        type: "array",
                        minItems: 1,
                        maxItems: 2,
                        items: { type: "string", enum: [...allowedEvidence] },
                      },
                    },
                  },
                },
                caveats: {
                  type: "array",
                  maxItems: allowedCaveats.length,
                  items: { type: "string", enum: allowedCaveats },
                },
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
              maxItems: 3,
              items: { type: "string" },
            },
          },
        },
      },
    },
    ),
  );

  const analyzed = await parseAnalysisWithOneRetry(
    requestAnalysis,
    columns,
    allowedEvidence,
    numericColumns,
    allowedCaveats,
  );
  if (sampling && !analyzed.analysis.caveats.includes(sampling)) {
    analyzed.analysis.caveats.push(sampling);
  }
  return analyzed;
}
