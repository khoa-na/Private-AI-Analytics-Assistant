import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type EvalCase = {
  id: string;
  category: string;
  language?: string;
  difficulty?: string;
  question: string;
  outputShape: string;
  expectedColumns?: string[];
  expectedColumnsExact?: boolean;
  expectedRowCount?: number;
  expectedTruncated?: boolean;
  expectedChartType?: string;
  expectedChart?: { type: string; xKey?: string; yKeys?: string[] };
  expectedFacts?: Array<{ column?: string; rowIndex?: number }>;
  expectedSteps?: Array<{ expectedTables: string[] }>;
  requiredSqlPatterns?: string[];
  forbiddenSqlPatterns?: string[];
  expectedSummaryPatterns?: string[];
  forbiddenSummaryPatterns?: string[];
  requiredMessagePatterns?: string[];
  forbiddenMessagePatterns?: string[];
  requiredCaveatPatterns?: string[];
  forbiddenCaveatPatterns?: string[];
  requiredAnalysisPatterns?: string[];
  forbiddenAnalysisPatterns?: string[];
};

function readSuite(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as EvalCase[];
}

function validateCommon(cases: EvalCase[]) {
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  assert.ok(cases.every(({ question }) => question.trim().length > 0));
  const patterns = cases.flatMap((test) => [
    ...(test.requiredSqlPatterns ?? []),
    ...(test.forbiddenSqlPatterns ?? []),
    ...(test.expectedSummaryPatterns ?? []),
    ...(test.forbiddenSummaryPatterns ?? []),
    ...(test.requiredMessagePatterns ?? []),
    ...(test.forbiddenMessagePatterns ?? []),
    ...(test.requiredCaveatPatterns ?? []),
    ...(test.forbiddenCaveatPatterns ?? []),
    ...(test.requiredAnalysisPatterns ?? []),
    ...(test.forbiddenAnalysisPatterns ?? []),
  ]);
  assert.doesNotThrow(() => patterns.forEach((pattern) => new RegExp(pattern, "i")));
}

const questions = readSuite("evals/questions.json");
validateCommon(questions);

assert.equal(questions.length, 73);

const hm = readSuite("evals/hm.json");
validateCommon(hm);
assert.equal(hm.length, 97);
assert.equal(hm.filter(({ language }) => language === "en").length, 48);
assert.equal(hm.filter(({ language }) => language === "vi").length, 49);
assert.ok(hm.every(({ difficulty }) =>
  ["basic", "intermediate", "advanced", "expert"].includes(difficulty ?? ""),
));
assert.ok(hm.some(({ expectedFacts }) => expectedFacts?.length));
assert.ok(hm.flatMap(({ expectedFacts }) => expectedFacts ?? []).every(({ column }) => column));
assert.ok(hm.flatMap(({ expectedFacts }) => expectedFacts ?? []).every(
  ({ rowIndex }) => rowIndex === undefined || Number.isInteger(rowIndex) && rowIndex >= 0,
));
assert.ok(hm.every(({ expectedRowCount }) =>
  expectedRowCount === undefined || Number.isInteger(expectedRowCount) && expectedRowCount >= 0,
));
assert.ok(hm.every(({ expectedChartType, expectedChart }) =>
  [expectedChartType, expectedChart?.type].filter(Boolean).every((type) =>
    ["bar", "line", "none"].includes(type ?? ""),
  ),
));
assert.ok(hm.every(({ expectedColumns, expectedColumnsExact }) =>
  !expectedColumnsExact || Boolean(expectedColumns?.length),
));
assert.ok(hm.some(({ outputShape }) => outputShape === "clarification"));
assert.ok(hm.some(({ outputShape }) => outputShape === "unsupported"));
assert.ok(hm.some(({ outputShape }) => outputShape === "refusal"));
assert.ok(hm.some(({ outputShape }) => outputShape === "multi_query"));
assert.ok(hm.every(({ outputShape, expectedSteps }) =>
  !expectedSteps || (outputShape === "multi_query" && expectedSteps.length >= 2 && expectedSteps.length <= 3),
));
assert.ok(hm.slice(72).every(({ outputShape, expectedFacts }) =>
  ["clarification", "unsupported", "refusal", "multi_query", "empty"].includes(outputShape) ||
    Boolean(expectedFacts?.length),
));

const hmText = JSON.stringify(hm);
const hmSchemaColumns = [
  "article_id", "product_code", "prod_name", "product_type_no", "product_type_name",
  "product_group_name", "graphical_appearance_no", "graphical_appearance_name",
  "colour_group_code", "colour_group_name", "perceived_colour_value_id",
  "perceived_colour_value_name", "perceived_colour_master_id",
  "perceived_colour_master_name", "department_no", "department_name", "index_code",
  "index_name", "index_group_no", "index_group_name", "section_no", "section_name",
  "garment_group_no", "garment_group_name", "detail_desc", "customer_id", "FN", "Active",
  "club_member_status", "fashion_news_frequency", "age", "postal_code", "t_dat", "price",
  "sales_channel_id",
];
assert.deepEqual(
  hmSchemaColumns.filter((column) => !new RegExp(`\\b${column}\\b`).test(hmText)),
  [],
);

console.log("eval question tests passed");
