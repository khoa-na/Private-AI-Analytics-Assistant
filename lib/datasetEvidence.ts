export type LlmPolicy = {
  sendExamples: boolean;
  sendFreeTextExamples: boolean;
  maskIdentifiers: boolean;
  maxExampleLength: number;
};

export type SemanticType = "date" | "flag" | "identifier" | "category" | "measure" | "number" | "free_text" | "text";
export type PrivacyClass = "none" | "identifier" | "quasi_identifier" | "direct_identifier" | "free_text";

export const DEFAULT_LLM_POLICY: LlmPolicy = {
  sendExamples: true,
  sendFreeTextExamples: false,
  maskIdentifiers: true,
  maxExampleLength: 80,
};

type ColumnEvidenceInput = {
  table: string;
  name: string;
  type: string;
  values: unknown[];
  profiledRows: number;
  rowCount: number;
  declaredPrimaryKey: boolean;
  policy: LlmPolicy;
};

function rate(value: number, total: number) {
  return total ? Number((value / total).toFixed(6)) : 0;
}

function semanticType(input: ColumnEvidenceInput, present: unknown[], distinctCount: number): SemanticType {
  const name = input.name.toLowerCase();
  const strings = present.map(String);
  const numeric = /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(input.type);
  const dateNamed = /(?:^|_)(?:date|datetime|timestamp|time|day|month|year|t_dat)(?:_|$)/i.test(name);
  const dateRate = strings.length ? strings.filter((value) => !Number.isNaN(Date.parse(value))).length / strings.length : 0;
  const isoDateValues = strings.length > 0 && strings.every((value) => /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value));
  const flagValues = new Set(strings.map((value) => value.trim().toLowerCase()));
  const flag = distinctCount > 0 && distinctCount <= 2 && [...flagValues].every((value) => ["0", "1", "0.0", "1.0", "true", "false", "yes", "no", "y", "n"].includes(value));
  const distinctRate = rate(distinctCount, input.profiledRows);
  const identifierNamed = /(?:^|_)(?:id|uuid|guid|key)(?:_|$)/i.test(name);
  const categoryNamed = /(?:^|_)(?:status|type|group|category|channel|code|no)(?:_|$)/i.test(name);
  const measureNamed = /(?:^|_)(?:amount|price|cost|revenue|sales|score|rate|quantity|qty|count|total)(?:_|$)/i.test(name);
  const freeText = /(?:desc|description|comment|review|message|notes?|text)/i.test(name) ||
    (strings.length > 0 && strings.reduce((total, value) => total + value.length, 0) / strings.length > 80);

  if ((dateNamed || isoDateValues) && dateRate >= 0.9) return "date";
  if (flag) return "flag";
  if (input.declaredPrimaryKey || (identifierNamed && distinctRate >= 0.5)) return "identifier";
  if (freeText) return "free_text";
  if (categoryNamed || (!numeric && distinctCount <= Math.max(20, input.profiledRows * 0.02))) return "category";
  if (numeric && measureNamed) return "measure";
  if (numeric) return "number";
  return "text";
}

function privacyClass(table: string, name: string, type: SemanticType, values: unknown[]): PrivacyClass {
  const reference = `${table}.${name}`.toLowerCase();
  const strings = values.slice(0, 100).map(String);
  const personName = /(?:customer|user|person|member|client|employee|patient)/.test(table.toLowerCase()) && /^name$/i.test(name);
  if (
    personName ||
    /email|e_mail|phone|mobile|address|first_name|last_name|full_name|ssn|social_security|passport|national_id|card_number|credit_card|account_number|routing_number|iban|username|user_name|ip_address|mac_address/.test(reference) ||
    strings.some((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
  ) {
    return "direct_identifier";
  }
  if (/postal|zip|postcode|date_of_birth|birth_date|(?:^|[._])dob(?:$|[._])|(?:^|[._])age(?:$|[._])|gender/.test(reference)) return "quasi_identifier";
  if (type === "identifier") return "identifier";
  if (type === "free_text") return "free_text";
  return "none";
}

export function buildColumnEvidence(input: ColumnEvidenceInput) {
  const present = input.values.filter((value) => value !== null && value !== undefined);
  const counts = new Map<string, number>();
  for (const value of present) {
    const text = String(value);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const distinctValues = [...counts.keys()];
  const distinctCount = distinctValues.length;
  const nullCount = input.profiledRows - present.length;
  const role = semanticType(input, present, distinctCount);
  const privacy = privacyClass(input.table, input.name, role, present);
  const redact =
    !input.policy.sendExamples ||
    (input.policy.maskIdentifiers && ["identifier", "quasi_identifier", "direct_identifier"].includes(privacy)) ||
    (privacy === "free_text" && !input.policy.sendFreeTextExamples);
  const safe = (value: string) => value.length <= input.policy.maxExampleLength
    ? value
    : `${value.slice(0, input.policy.maxExampleLength - 1)}…`;
  const examples = redact ? [] : distinctValues.slice(0, 3).map(safe);
  const topValues = redact || !["category", "flag"].includes(role)
    ? []
    : [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([value, count]) => ({ value: safe(value), count }));
  const numericValues = /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(input.type)
    ? present.map(Number).filter(Number.isFinite)
    : [];
  const dateValues = role === "date" ? present.map(String).filter((value) => !Number.isNaN(Date.parse(value))).sort() : [];
  const candidateKey = input.declaredPrimaryKey || (
    input.rowCount > 0 && input.profiledRows === input.rowCount && nullCount === 0 && distinctCount === input.rowCount
  );

  return {
    nullCount,
    nullRate: rate(nullCount, input.profiledRows),
    distinctCount,
    distinctRate: rate(distinctCount, input.profiledRows),
    examples,
    topValues,
    semanticType: role,
    privacy: { classification: privacy, examplesRedacted: redact },
    ...(!redact && numericValues.length ? { min: Math.min(...numericValues), max: Math.max(...numericValues) } : {}),
    ...(!redact && dateValues.length ? { minValue: dateValues[0], maxValue: dateValues.at(-1) } : {}),
    ...(!redact && present.length ? {
      averageLength: Number((present.reduce<number>((total, value) => total + String(value).length, 0) / present.length).toFixed(2)),
    } : {}),
    candidateKey,
  };
}
