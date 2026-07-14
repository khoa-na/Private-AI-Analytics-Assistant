import type { DatasetProfile } from "./datasetImport";

export type Provenance = {
  source: "database_constraint" | "measured_profile" | "dataset_manifest" | "llm_inference" | "human_confirmation";
  evidence: string[];
};

type CatalogEnrichment = {
  overview?: string;
  tableDescriptions?: Record<string, string>;
  columnDescriptions?: Record<string, string>;
};

function claim(text: string, source: Provenance["source"], evidence: string[], status: "measured" | "candidate" | "unknown") {
  return { text, status, provenance: { source, evidence } satisfies Provenance };
}

export function createDatasetCatalog(
  profile: DatasetProfile,
  enrichment: CatalogEnrichment,
  generatedBy: "ai" | "deterministic",
) {
  const totalRows = profile.tables.reduce((total, table) => total + table.rowCount, 0);
  const tables = Object.fromEntries(profile.tables.map((table) => {
    const key = table.columns.find(({ candidateKey }) => candidateKey);
    const tableDescription = enrichment.tableDescriptions?.[table.name];
    return [table.name, {
      description: tableDescription
        ? claim(tableDescription, "llm_inference", [`profile:${table.name}`], "candidate")
        : claim(`${table.rowCount} rows; business purpose is not documented.`, "measured_profile", [`row_count=${table.rowCount}`], "unknown"),
      grain: key
        ? claim(`One row per unique ${key.name}; business grain still requires confirmation.`, key.declaredPrimaryKey ? "database_constraint" : "measured_profile", [`${table.name}.${key.name}`], "candidate")
        : claim("Row grain is not confirmed.", "measured_profile", ["No full-table candidate key was found."], "unknown"),
      rowCount: table.rowCount,
      profiledRows: table.profiledRows,
      profileMethod: table.profileMethod,
      columns: Object.fromEntries(table.columns.map((column) => {
        const reference = `${table.name}.${column.name}`;
        const ambiguousAcronym = /^[A-Z][A-Z0-9_]{1,3}$/.test(column.name);
        const description = ambiguousAcronym ? undefined : enrichment.columnDescriptions?.[reference];
        return [column.name, {
          description: description
            ? claim(description, "llm_inference", [reference], "candidate")
            : claim("Business meaning is not documented.", "measured_profile", [reference], "unknown"),
          physicalType: column.type,
          semanticType: column.semanticType,
          privacy: column.privacy,
          statistics: {
            nullCount: column.nullCount,
            nullRate: column.nullRate,
            distinctCount: column.distinctCount,
            distinctRate: column.distinctRate,
            examples: column.examples,
            topValues: column.topValues,
            ...(column.min !== undefined ? { min: column.min } : {}),
            ...(column.max !== undefined ? { max: column.max } : {}),
            ...(column.minValue !== undefined ? { minValue: column.minValue } : {}),
            ...(column.maxValue !== undefined ? { maxValue: column.maxValue } : {}),
            ...(column.averageLength !== undefined ? { averageLength: column.averageLength } : {}),
          },
          key: {
            declaredPrimaryKey: column.declaredPrimaryKey,
            candidateKey: column.candidateKey,
          },
          provenance: {
            source: "measured_profile",
            evidence: [`${table.profileMethod} sample of ${table.profiledRows} rows`],
          } satisfies Provenance,
        }];
      })),
      unknowns: [
        ...(!key ? ["Business grain requires confirmation."] : []),
        ...table.columns
          .filter(({ privacy }) => privacy.examplesRedacted)
          .map(({ name }) => `${name} examples were redacted by llmPolicy.`),
      ],
    }];
  }));

  return {
    schema_version: 1,
    dataset: profile.dataset,
    generated_by: generatedBy,
    overview: enrichment.overview
      ? claim(enrichment.overview, "llm_inference", ["dataset profile"], "candidate")
      : claim(`${profile.tables.length} tables and ${totalRows} total rows. Business scope requires confirmation.`, "measured_profile", [`tables=${profile.tables.length}`, `rows=${totalRows}`], "unknown"),
    llmPolicy: profile.llmPolicy,
    tables,
    relationshipCandidates: profile.relationshipCandidates.map((relationship) => ({
      ...relationship,
      provenance: {
        source: "measured_profile",
        evidence: [`${relationship.sampledValues} sampled values; ${(relationship.overlap * 100).toFixed(1)}% overlap`],
      } satisfies Provenance,
    })),
    analysisHints: (profile.analysisHints ?? []).map((text) => ({
      text,
      provenance: { source: "dataset_manifest", evidence: ["dataset.json analysisHints"] } satisfies Provenance,
    })),
  };
}

type DatasetCatalog = ReturnType<typeof createDatasetCatalog>;

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderCatalogMarkdown(catalog: DatasetCatalog) {
  const lines = [
    `# ${catalog.dataset} dataset guide`,
    "",
    "## Scope",
    "",
    catalog.overview.text,
    "",
    "## Privacy policy",
    "",
    `Examples: ${catalog.llmPolicy.sendExamples ? "enabled" : "disabled"}; identifiers masked: ${catalog.llmPolicy.maskIdentifiers}; free-text examples: ${catalog.llmPolicy.sendFreeTextExamples ? "enabled" : "disabled"}.`,
    "",
    "## Tables and columns",
    "",
    "Descriptions marked candidate are LLM inferences and require review; unknown means no supported business definition was found.",
    "",
  ];
  for (const [tableName, table] of Object.entries(catalog.tables)) {
    lines.push(`### ${tableName}`, "", `${table.description.text} [${table.description.status}]`, "", `Grain: ${table.grain.text}`, "");
    for (const [columnName, column] of Object.entries(table.columns)) {
      const stats = column.statistics;
      const range = stats.minValue !== undefined
        ? `, range ${stats.minValue} to ${stats.maxValue}`
        : stats.min !== undefined ? `, range ${stats.min} to ${stats.max}` : "";
      const top = stats.topValues.length ? `, top values ${stats.topValues.map(({ value, count }) => `${value} (${count})`).join(", ")}` : "";
      const privacy = column.privacy.classification !== "none" ? `, privacy ${column.privacy.classification}` : "";
      lines.push(`- \`${columnName}\` — ${column.semanticType}/${column.physicalType}; null ${percent(stats.nullRate)}, distinct ${percent(stats.distinctRate)}${range}${top}${privacy}. ${column.description.text} [${column.description.status}]`);
    }
    if (table.unknowns.length) lines.push("", "Unknowns:", ...table.unknowns.map((item) => `- ${item}`));
    lines.push("");
  }
  lines.push("## Relationship candidates", "");
  if (!catalog.relationshipCandidates.length) lines.push("No relationships were inferred.");
  for (const relationship of catalog.relationshipCandidates) {
    lines.push(`- ${relationship.from} -> ${relationship.to} (${(relationship.overlap * 100).toFixed(1)}% sampled overlap; needs review)`);
  }
  if (catalog.analysisHints.length) lines.push("", "## Analysis hints", "", ...catalog.analysisHints.map(({ text }) => `- ${text}`));
  return `${lines.join("\n").trim()}\n`;
}

export function renderRuntimeMarkdown(catalog: DatasetCatalog) {
  const totalRows = Object.values(catalog.tables).reduce((total, table) => total + table.rowCount, 0);
  const lines = [
    `# ${catalog.dataset} runtime guide`,
    "",
    `${Object.keys(catalog.tables).length} tables and ${totalRows} total rows. Business scope requires confirmation.`,
    "",
    "## Tables",
    "",
  ];
  for (const [tableName, table] of Object.entries(catalog.tables)) {
    lines.push(`- ${tableName}: ${table.rowCount} rows. Grain: ${table.grain.text}`);
  }
  if (catalog.analysisHints.length) lines.push("", "## Analysis hints", "", ...catalog.analysisHints.map(({ text }) => `- ${text}`));
  lines.push("", "Only confirmed semantic.json relationships and measures are authoritative. Candidate descriptions require review.");
  return `${lines.join("\n").trim()}\n`;
}
