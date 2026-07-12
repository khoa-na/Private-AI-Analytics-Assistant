import type { ResultProfile, Row } from "./analyticsTypes";
import { evidenceFromRows } from "./llmAnalysis";

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
    ([token]) => ({ token, candidates: numericCandidates(token) }),
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
  const label = labels[0];
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
) {
  const allowedEvidence = evidenceFromRows(profile.sampleRows);
  const allowedNumbers = [
    ...[...allowedEvidence].flatMap((evidence) =>
      numbersIn(evidence).flatMap(({ candidates }) => candidates),
    ),
    profile.rowCount,
    ...(profile.truncated ? [1000] : []),
  ];
  const unsupportedNumbers = numbersIn(summary)
    .filter(({ candidates }) =>
      !candidates.some((candidate) =>
        allowedNumbers.some(
          (allowed) => Math.abs(candidate - allowed) <= Math.max(0.01, Math.abs(allowed) * 0.001),
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
