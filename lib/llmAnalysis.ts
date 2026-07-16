import type { Analysis, ChartSpec, ResultProfile, Row } from "./analyticsTypes";
import { getDatasetGuide } from "./datasetGuide";
import { completeChat, stageReasoningEffort, tokenBudget } from "./llmClient";
import { parseLastJsonObject } from "./jsonOutput";
import { atStage } from "./pipelineError";
import type { AnalysisBrief } from "./queryPlan";
import { evidenceFromRows } from "./resultProfile";
import { evaluateSummary } from "./summaryEvaluation";

export { evidenceFromRows } from "./resultProfile";

type AnalysisResult = {
  analysis: Analysis;
  chart: ChartSpec;
  followUpQuestions: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  validate?: (result: AnalysisResult) => string | undefined,
) {
  const parseValidated = async (correction?: string) => {
    const result = parseAnalysis(
      await request(correction),
      columns,
      allowedEvidence,
      numericColumns,
      allowedCaveats,
    );
    const reason = validate?.(result);
    if (reason) throw new Error(reason);
    return result;
  };
  try {
    return await parseValidated();
  } catch (firstError) {
    try {
      return await parseValidated(
        firstError instanceof Error ? firstError.message : "Invalid analysis output.",
      );
    } catch {
      const evidence = [...allowedEvidence].slice(0, 3);
      return {
        analysis: {
          summary: evidence.length
            ? `Validated evidence: ${evidence.join(", ")}.`
            : "The query succeeded, but no row evidence was available.",
          summaryEvidence: evidence,
          insights: [],
          caveats: [...allowedCaveats, "A deterministic evidence fallback was used because model analysis was unavailable."],
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

function requestedCaveats(question: string) {
  return [
    ...(/\bcensor|quan sát thiếu|biên dữ liệu/i.test(question)
      ? ["The result is subject to left/right censoring at the observed data boundaries."]
      : []),
    ...(/\bpartial|\bincomplete|không đầy đủ|chưa đầy đủ|boundary months|tháng biên/i.test(question)
      ? ["The requested comparison includes a partial or incomplete data period."]
      : []),
  ];
}

function caveatsFromProfile(profile: ResultProfile, question = "", extraCaveats: string[] = []) {
  const sampling = samplingCaveat(profile);
  return [...new Set([
    ...(profile.truncated ? ["Results were limited to 1000 rows."] : []),
    ...(sampling ? [sampling] : []),
    ...profile.columns
      .filter(({ nullCount }) => nullCount > 0)
      .map(({ name, nullCount }) => `${name} contains ${nullCount} null values.`),
    ...requestedCaveats(question),
    ...extraCaveats,
  ])];
}

function evidenceFromRow(row: Row) {
  return Object.entries(row).map(([column, value]) => `${column} = ${String(value)}`);
}

export function deterministicAnalysis(
  question: string,
  _sql: string,
  profile: ResultProfile,
  extraCaveats: string[] = [],
): AnalysisResult | undefined {
  if (!profile.rowCount) return;

  const vietnamese = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i.test(question);
  const caveats = caveatsFromProfile(profile, question, extraCaveats);
  const first = profile.sampleRows[0];

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
}

export async function analyzeResult(
  question: string,
  sql: string,
  profile: ResultProfile,
  useDeterministic = true,
  brief?: AnalysisBrief,
  qualityCaveats: string[] = [],
) {
  if (!profile.rowCount) {
    return {
      analysis: {
        summary: "The query returned no data.",
        summaryEvidence: [],
        insights: [],
        caveats: [...new Set(["There is no evidence available for this question.", ...qualityCaveats])],
      },
      chart: {
        type: "none" as const,
        reason: "The query returned no data to visualize.",
      },
      followUpQuestions: [],
    };
  }

  // ponytail: bound wide result prompts; add relevance-based column selection only when wide-table evals require it.
  const evidenceRowLimit = Math.max(1, Math.floor(200 / Math.max(1, profile.columns.length)));
  if (profile.sampleRows.length > evidenceRowLimit) {
    profile = { ...profile, sampleRows: profile.sampleRows.slice(0, evidenceRowLimit) };
  }

  const allowedEvidence = evidenceFromRows(profile.sampleRows);
  const deterministic = useDeterministic
    ? deterministicAnalysis(question, sql, profile, qualityCaveats)
    : undefined;
  const sampling = samplingCaveat(profile);
  if (deterministic) return deterministic;

  const allowedCaveats = caveatsFromProfile(profile, question, qualityCaveats);
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
          brief,
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
      responseFormat: { type: "json_object" },
    },
    ),
  );

  const analyzed = await parseAnalysisWithOneRetry(
    requestAnalysis,
    columns,
    allowedEvidence,
    numericColumns,
    allowedCaveats,
    (result) => {
      const validation = evaluateSummary(
        result.analysis.summary,
        result.analysis.summaryEvidence,
        result.analysis.caveats,
        profile,
        [],
        [],
        profile.sampleRows,
        question,
      );
      const failures = [
        ...(validation.numbersGrounded ? [] : [`Unsupported numbers: ${validation.unsupportedNumbers.join(", ")}.`]),
        // ponytail: cross-step comparison validation needs sentence-to-step provenance.
        ...(profile.sampleRows.some((row) => "analysis_step" in row) ? [] : validation.comparisons.failures),
      ];
      return failures.length ? failures.join(" ") : undefined;
    },
  );
  if (sampling && !analyzed.analysis.caveats.includes(sampling)) {
    analyzed.analysis.caveats.push(sampling);
  }
  for (const caveat of requestedCaveats(question)) {
    if (!analyzed.analysis.caveats.includes(caveat)) analyzed.analysis.caveats.push(caveat);
  }
  return analyzed;
}
