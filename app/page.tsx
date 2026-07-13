"use client";

import { useEffect, useState } from "react";
import { ChartPanel } from "@/components/ChartPanel";
import { InsightPanel } from "@/components/InsightPanel";
import { ResultTable } from "@/components/ResultTable";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import type { Analysis, AnalysisStep, ChartSpec, Row, Schema } from "@/lib/analyticsTypes";
import styles from "./page.module.css";

export default function Home() {
  const [schema, setSchema] = useState<Schema>({});
  const [question, setQuestion] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<Analysis | null>(null);
  const [sql, setSql] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [chart, setChart] = useState<ChartSpec>();
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [steps, setSteps] = useState<AnalysisStep[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [insightsBusy, setInsightsBusy] = useState(false);

  function clearResult() {
    setRows([]);
    setColumns([]);
    setAnalysis(null);
    setAiAnalysis(null);
    setSql("");
    setTruncated(false);
    setChart(undefined);
    setFollowUps([]);
    setSteps([]);
  }

  function handleQuestionChange(value: string) {
    setQuestion(value);
    clearResult();
    setMessage("Click Analyze to generate SQL and insights for this question.");
  }

  useEffect(() => {
    fetch("/api/schema")
      .then((response) => response.json())
      .then((data) => setSchema(data.schema ?? {}))
      .catch(() => setMessage("Could not load database schema."));
  }, []);

  async function analyze() {
    if (busy || !question.trim()) return;

    setBusy(true);
    clearResult();
    setMessage("Generating SQL with the local model...");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "AI request failed.");
      if (data.intent && data.intent !== "query") {
        setMessage(data.message);
        return;
      }
      if (data.mode === "multi_query") {
        setSteps(data.steps);
        setAnalysis(data.analysis);
        setFollowUps(data.followUpQuestions ?? []);
        setMessage(
          `Completed ${data.steps.length} analysis steps in ${
            data.timings.sqlGenerationMs + data.timings.queryMs + data.timings.analysisMs
          } ms.`,
        );
        return;
      }
      setRows(data.result.rows);
      setSql(data.result.sql);
      setTruncated(data.result.truncated);
      setColumns(data.result.columns);
      setAnalysis(data.analysis);
      setChart(data.chart);
      setFollowUps(data.followUpQuestions ?? []);
      setMessage(
        `Analyzed ${data.result.rowCount} rows in ${
          data.timings.sqlGenerationMs + data.timings.queryMs + data.timings.analysisMs
        } ms.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function generateInsights() {
    if (insightsBusy || !sql || !rows.length) return;

    setInsightsBusy(true);
    try {
      const response = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          sql,
          rows,
          truncated,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Insight generation failed.");
      setAiAnalysis(data.analysis);
      setFollowUps(data.followUpQuestions ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Insight generation failed.");
    } finally {
      setInsightsBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <SchemaSidebar schema={schema} />

      <section className={styles.workspace}>
        <form
          className={styles.panel}
          onSubmit={(event) => {
            event.preventDefault();
            void analyze();
          }}
        >
          <label>
            Business question
            <input
              value={question}
              onChange={(event) => handleQuestionChange(event.target.value)}
              placeholder="Ask about revenue, delivery, reviews, products..."
            />
          </label>

          <div className={styles.actions}>
            <button type="submit" disabled={busy || !question.trim()}>
              {busy ? "Analyzing..." : "Analyze"}
            </button>
          </div>

          {message ? <p className={styles.message}>{message}</p> : null}
        </form>

        <InsightPanel
          analysis={analysis}
          aiAnalysis={aiAnalysis}
          canGenerateInsights={Boolean(rows.length && sql && !analysis?.insights.length)}
          insightsBusy={insightsBusy}
          onGenerateInsights={() => void generateInsights()}
        />
        {steps.length ? (
          <section className={styles.panel}>
            <h2>Analysis plan</h2>
            {steps.map((step, index) => (
              <div key={`${index}-${step.purpose}`}>
                <h3>{index + 1}. {step.purpose}</h3>
                <p>{step.question}</p>
                <pre>{step.result.sql}</pre>
                <ResultTable columns={step.result.columns} rows={step.result.rows} />
              </div>
            ))}
          </section>
        ) : null}
        <ChartPanel rows={rows} busy={busy} chart={chart} />
        {!steps.length ? <ResultTable columns={columns} rows={rows} /> : null}
        {followUps.length ? (
          <section className={styles.panel}>
            <h2>Follow-up questions</h2>
            <ul>
              {followUps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    </main>
  );
}
