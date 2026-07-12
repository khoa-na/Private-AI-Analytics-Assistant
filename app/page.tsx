"use client";

import { useEffect, useState } from "react";
import { ChartPanel } from "@/components/ChartPanel";
import { InsightPanel } from "@/components/InsightPanel";
import { ResultTable } from "@/components/ResultTable";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import type { Analysis, ChartSpec, Row, Schema } from "@/lib/analyticsTypes";
import { EXAMPLES } from "@/lib/examples";
import styles from "./page.module.css";

export default function Home() {
  const [schema, setSchema] = useState<Schema>({});
  const [question, setQuestion] = useState<string>(EXAMPLES[0].question);
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [chart, setChart] = useState<ChartSpec>();
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function clearResult() {
    setRows([]);
    setColumns([]);
    setAnalysis(null);
    setChart(undefined);
    setFollowUps([]);
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
      setRows(data.result.rows);
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
          <div className={styles.examples}>
            {EXAMPLES.map((example) => (
              <button
                className="secondary"
                type="button"
                key={example.label}
                onClick={() => {
                  setQuestion(example.question);
                  clearResult();
                  setMessage("Example loaded. Click Analyze to run it.");
                }}
              >
                {example.label}
              </button>
            ))}
          </div>

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

        <InsightPanel analysis={analysis} />
        <ChartPanel rows={rows} busy={busy} chart={chart} />
        <ResultTable columns={columns} rows={rows} />
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
