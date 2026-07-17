import type { ResultProfile, Row } from "./analyticsTypes";
import { evidenceFromRows } from "./resultProfile";

export const CASE_STATUSES = [
  "PASS_FIRST_TRY",
  "PASS_AFTER_REVIEW_REPAIR",
  "PASS_AFTER_SQL_REPAIR",
  "PASS_CORE_FAIL_PRESENTATION",
  "FAIL_CORRECTNESS",
  "FAIL_SAFETY",
  "FAIL_ANALYSIS",
  "FAIL_PIPELINE",
] as const;
export type CaseStatus = typeof CASE_STATUSES[number];

export function caseStatus({
  corePassed,
  presentationPassed = true,
  reviewRepaired = false,
  sqlRepaired = false,
  failure = "correctness",
}: {
  corePassed: boolean;
  presentationPassed?: boolean;
  reviewRepaired?: boolean;
  sqlRepaired?: boolean;
  failure?: "correctness" | "safety" | "analysis" | "pipeline";
}): CaseStatus {
  if (!corePassed) return `FAIL_${failure.toUpperCase()}` as CaseStatus;
  if (!presentationPassed) return "PASS_CORE_FAIL_PRESENTATION";
  if (reviewRepaired) return "PASS_AFTER_REVIEW_REPAIR";
  if (sqlRepaired) return "PASS_AFTER_SQL_REPAIR";
  return "PASS_FIRST_TRY";
}

export type NonQueryIntent = "clarification" | "unsupported" | "refusal";

export function intentMatchesExpected(actual: NonQueryIntent, expected?: NonQueryIntent) {
  if (!expected) return false;
  if (actual === expected) return true;
  if (expected === "unsupported") return actual === "clarification" || actual === "refusal";
  return expected === "refusal" && actual === "unsupported";
}

export function matchesTextPatterns(text: string, required: string[] = [], forbidden: string[] = []) {
  const normalized = `${text} ${text
    .replace(/\bnot available\b/gi, "unavailable missing")
    .replace(/\bnot defined\b/gi, "undefined unavailable missing không có")
    .replace(/\bdenominator\b/gi, "denominator mẫu số")
    .replace(/\bdoes not (?:include|contain|have)\b/gi, "missing unavailable")
    .replace(/\bdefinitions?\b/gi, "define meaning")}`;
  return required.every((pattern) => new RegExp(pattern, "i").test(normalized)) &&
    forbidden.every((pattern) => !new RegExp(pattern, "i").test(normalized));
}

export function hasExpectedFacts(rows: Row[], patterns: string[] = []) {
  const values = rows.flatMap((row) => Object.values(row)).map(String);
  return patterns.every((pattern) => {
    const valuePattern = pattern.includes(" = ") ? pattern.split(" = ").at(-1)! : pattern;
    return values.some((value) => new RegExp(`^${valuePattern}$`, "i").test(value));
  });
}

export type ExpectedFact = {
  column?: string;
  value: string | number;
  tolerance?: number;
  where?: Record<string, string | number>;
  rowIndex?: number;
};

function periodSignature(value: string) {
  const normalized = value.toLowerCase()
    .replace(/jan(?:uary)?/g, "01").replace(/feb(?:ruary)?/g, "02")
    .replace(/mar(?:ch)?/g, "03").replace(/apr(?:il)?/g, "04")
    .replace(/may/g, "05").replace(/jun(?:e)?/g, "06")
    .replace(/jul(?:y)?/g, "07").replace(/aug(?:ust)?/g, "08")
    .replace(/sep(?:tember)?/g, "09").replace(/oct(?:ober)?/g, "10")
    .replace(/nov(?:ember)?/g, "11").replace(/dec(?:ember)?/g, "12");
  const iso = normalized.match(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-([0-2]\d|3[01]))?/);
  if (iso) return { year: iso[1], month: String(Number(iso[2])), day: iso[3] ? String(Number(iso[3])) : undefined };
  const year = normalized.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const monthDays = [...normalized.matchAll(/(?:^|\D)(0?[1-9]|1[0-2])\D+(0?[1-9]|[12]\d|3[01])(?:\D|$)/g)];
  const last = monthDays.at(-1);
  return year ? { year, month: last ? String(Number(last[1])) : undefined, day: last ? String(Number(last[2])) : undefined } : undefined;
}

function matchesValue(value: unknown, expected: string | number, tolerance = 0, column = "") {
  if (typeof expected === "number" && typeof value === "number") {
    return Math.abs(value - expected) <= tolerance;
  }
  const actualText = String(value).toLowerCase();
  const expectedText = String(expected).toLowerCase();
  if (actualText === expectedText) return true;
  if (/(?:bucket|band)/i.test(column)) {
    const bucket = (text: string) => text.replace(/^(?:over|more than)\s+(\d+)$/, ">$1");
    if (bucket(actualText) === bucket(expectedText)) return true;
  }
  if (!/(?:period|year|month|date)/i.test(column)) return false;
  const actualPeriod = periodSignature(actualText);
  const expectedPeriod = periodSignature(expectedText);
  return Boolean(
    actualPeriod && expectedPeriod && actualPeriod.year === expectedPeriod.year &&
    (!expectedPeriod.month || actualPeriod.month === expectedPeriod.month) &&
    (!expectedPeriod.day || actualPeriod.day === expectedPeriod.day),
  );
}

export function matchesSqlRequirement(sql: string, pattern: string) {
  if (new RegExp(pattern, "i").test(sql)) return true;
  return /^with$/i.test(pattern.trim()) && /\b(?:from|join)\s*\(\s*select\b/i.test(sql);
}

export function evaluateExpectedFacts(rows: Row[], facts: ExpectedFact[] = []) {
  return facts.every((fact) => {
    const candidates = fact.rowIndex === undefined ? rows : [rows[fact.rowIndex]];
    return candidates.some((row) => {
      if (!row) return false;
      if (fact.where && !Object.entries(fact.where).every(
        ([column, value]) => matchesValue(row[column], value, 0, column),
      )) return false;
      const values = fact.column ? [row[fact.column]] : Object.values(row);
      return values.some((value) =>
        value !== null && matchesValue(value, fact.value, fact.tolerance, fact.column),
      );
    });
  });
}

function numericCandidates(token: string) {
  const value = token.replace(/[.,]+$/, "");
  const candidates = new Set<number>();
  const add = (candidate: string) => {
    const number = Number(candidate);
    if (Number.isFinite(number)) candidates.add(number);
  };

  add(value.replace(",", "."));
  add(value.replace(/[.,]/g, ""));

  const separator = Math.max(value.lastIndexOf("."), value.lastIndexOf(","));
  if (separator > 0) {
    add(`${value.slice(0, separator).replace(/[.,]/g, "")}.${value.slice(separator + 1)}`);
  }
  return [...candidates];
}

function numbersIn(text: string) {
  return [...text.matchAll(/(?<![A-Za-z0-9])[-+]?\d[\d.,]*(?![A-Za-z0-9])/g)].map(
    (match) => {
      const token = match[0];
      const candidates = numericCandidates(token);
      const suffix = text.slice((match.index ?? 0) + token.length);
      const scale = /^\s*(?:%|percent(?:age)?\b|phần trăm\b)/i.test(suffix)
        ? 0.01
        : /^\s*(?:thousand\b|nghìn\b|ngàn\b)/i.test(suffix)
          ? 1_000
          : /^\s*(?:million\b|triệu\b)/i.test(suffix)
            ? 1_000_000
            : /^\s*(?:billion\b|tỷ\b|tỉ\b)/i.test(suffix)
              ? 1_000_000_000
              : undefined;
      return {
        token,
        candidates: scale ? [...candidates, ...candidates.map((value) => value * scale)] : candidates,
      };
    },
  );
}

function supportsThreshold(summary: string, token: string, rows: Row[]) {
  const thresholdToken = token.replace(/[.,]+$/, "");
  const escaped = thresholdToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lower = new RegExp(
    `(?:under|below|fewer than|less than|dưới|ít hơn|thấp hơn)\\s+${escaped}\\b`,
    "i",
  ).test(summary);
  const upper = new RegExp(
    `(?:over|above|more than|greater than|trên|nhiều hơn|cao hơn)\\s+${escaped}\\b`,
    "i",
  ).test(summary);
  if (!lower && !upper) return false;
  const values = rows.flatMap((row) => Object.values(row)).filter(
    (value): value is number => typeof value === "number",
  );
  return numericCandidates(thresholdToken).some((threshold) =>
    values.some((value) => lower ? value < threshold : value > threshold),
  );
}

function mentions(summary: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(value.length <= 3 ? `(?:^|\\W)${escaped}(?:$|\\W)` : escaped, "i").test(summary);
}

export function evaluateComparisons(summary: string, rows: Row[], evidence: string[] = []) {
  if (rows.length < 2) return { checked: false, valid: true, failures: [] as string[] };

  const columns = Object.keys(rows[0]);
  const numeric = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "number"),
  );
  const labels = columns.filter((column) => !numeric.includes(column));
  const namedMetric = numeric.find((column) =>
    summary.toLowerCase().includes(column.replaceAll("_", " ").toLowerCase()),
  );
  const metric = namedMetric ?? numeric.at(-1);
  const label = labels.find((column) =>
    rows.some((row) => row[column] !== null && mentions(summary, String(row[column]))),
  ) ?? labels.at(-1);
  if (!metric || !label) return { checked: false, valid: true, failures: [] as string[] };

  const values = rows.filter((row) => typeof row[metric] === "number");
  const max = Math.max(...values.map((row) => row[metric] as number));
  const min = Math.min(...values.map((row) => row[metric] as number));
  const maxLabels = values.filter((row) => row[metric] === max).map((row) => String(row[label]));
  const minLabels = values.filter((row) => row[metric] === min).map((row) => String(row[label]));
  const highClaim = /highest|\bmost\b|maximum|cao nhất|nhiều nhất|lớn nhất/i.test(summary);
  const lowClaim = /lowest|\bleast\b|minimum|thấp nhất|ít nhất|nhỏ nhất/i.test(summary);
  const majorityClaim = /majority|more than half|đa số|phần lớn/i.test(summary);
  const increasingClaim = /increased steadily|monotonically increasing|tăng dần|tăng đều/i.test(summary);
  const decreasingClaim = /decreased steadily|monotonically decreasing|giảm dần|giảm đều/i.test(summary);
  const failures: string[] = [];
  const evidenceSupports = (entityLabels: string[], value: number) =>
    entityLabels.some((entity) => evidence.includes(`${label} = ${entity}`)) &&
    evidence.includes(`${metric} = ${value}`);

  if (
    highClaim &&
    !maxLabels.some((item) => mentions(summary, item)) &&
    !evidenceSupports(maxLabels, max)
  ) {
    failures.push(`highest ${metric} entity is not supported`);
  }
  if (
    lowClaim &&
    !minLabels.some((item) => mentions(summary, item)) &&
    !evidenceSupports(minLabels, min)
  ) {
    failures.push(`lowest ${metric} entity is not supported`);
  }
  if (majorityClaim) {
    const total = values.reduce((sum, row) => sum + (row[metric] as number), 0);
    if (!(total > 0 && max / total > 0.5 && maxLabels.some((item) => mentions(summary, item)))) {
      failures.push(`majority claim is not supported by ${metric}`);
    }
  }
  const ordered = values.map((row) => row[metric] as number);
  if (increasingClaim && !ordered.every((value, index) => !index || value >= ordered[index - 1])) {
    failures.push(`${metric} is not monotonically increasing`);
  }
  if (decreasingClaim && !ordered.every((value, index) => !index || value <= ordered[index - 1])) {
    failures.push(`${metric} is not monotonically decreasing`);
  }

  return {
    checked: highClaim || lowClaim || majorityClaim || increasingClaim || decreasingClaim,
    valid: failures.length === 0,
    failures,
  };
}

export function evaluateSummary(
  summary: string,
  summaryEvidence: string[],
  caveats: string[],
  profile: ResultProfile,
  expectedPatterns: string[] = [],
  forbiddenPatterns: string[] = [],
  rows: Row[] = profile.sampleRows,
  context = "",
) {
  const allowedEvidence = evidenceFromRows(profile.sampleRows);
  const allowedNumbers = [
    ...[...allowedEvidence].flatMap((evidence) =>
      numbersIn(evidence).flatMap(({ candidates }) => candidates),
    ),
    ...profile.columns.flatMap(({ min, max, average }) => [min, max, average]).filter(
      (value): value is number => typeof value === "number",
    ),
    profile.rowCount,
    ...(profile.truncated ? [1000] : []),
    ...numbersIn(context).flatMap(({ candidates }) => candidates),
  ];
  const unsupportedNumbers = numbersIn(summary)
    .filter(({ token, candidates }) =>
      !supportsThreshold(summary, token, rows) &&
      !candidates.some((candidate) =>
        allowedNumbers.some(
          (allowed) => Math.abs(candidate - allowed) <= Math.max(0.01, Math.abs(allowed) * 0.002),
        ),
      ),
    )
    .map(({ token }) => token);
  const truncationClaim = /truncat|\blimit(?:ed)?\b|\b1[,]?000 rows\b|giới hạn|mẫu 1[.]?000/i.test(
    `${summary} ${caveats.join(" ")}`,
  );
  const comparisons = evaluateComparisons(summary, rows, summaryEvidence);

  return {
    present: Boolean(summary.trim()),
    evidenceValid:
      summaryEvidence.length > 0 && summaryEvidence.every((item) => allowedEvidence.has(item)),
    numbersGrounded: unsupportedNumbers.length === 0,
    unsupportedNumbers,
    truncationValid: truncationClaim === profile.truncated,
    requiredPatterns: expectedPatterns.every((pattern) => new RegExp(pattern, "i").test(summary)),
    forbiddenPatterns: forbiddenPatterns.every((pattern) => !new RegExp(pattern, "i").test(summary)),
    comparisons,
  };
}
