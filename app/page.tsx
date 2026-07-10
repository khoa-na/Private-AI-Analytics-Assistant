"use client";

import { useEffect, useState } from "react";
import { ChartPanel } from "@/components/ChartPanel";
import { ResultTable } from "@/components/ResultTable";
import { SchemaSidebar } from "@/components/SchemaSidebar";
import type { Row, Schema } from "@/lib/analyticsTypes";
import { EXAMPLES } from "@/lib/examples";
import styles from "./page.module.css";

export default function Home() {
  const [schema, setSchema] = useState<Schema>({});
  const [question, setQuestion] = useState<string>(EXAMPLES[0].question);
  const [sql, setSql] = useState<string>(EXAMPLES[0].sql);
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function clearResult() {
    setRows([]);
    setColumns([]);
  }

  function handleQuestionChange(value: string) {
    setQuestion(value);
    setSql("");
    clearResult();
    setMessage("Click Ask AI to generate SQL for this question.");
  }

  useEffect(() => {
    fetch("/api/schema")
      .then((response) => response.json())
      .then((data) => setSchema(data.schema ?? {}))
      .catch(() => setMessage("Could not load database schema."));
  }, []);

  async function runQuery(nextSql = sql) {
    setBusy(true);
    setMessage("Running SQL...");
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: nextSql }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Query failed.");
      setRows(data.rows);
      setColumns(data.columns);
      setMessage(`Query returned ${data.rows.length} rows.`);
    } catch (error) {
      setRows([]);
      setColumns([]);
      setMessage(error instanceof Error ? error.message : "Query failed.");
    } finally {
      setBusy(false);
    }
  }

  async function askAi() {
    if (busy || !question.trim()) return;

    setBusy(true);
    setMessage("Generating SQL with the local model...");
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "AI request failed.");
      setSql(data.sql);
      setMessage(data.reason ?? "");
      await runQuery(data.sql);
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
            void askAi();
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
                  setSql(example.sql);
                  clearResult();
                  setMessage("Example SQL loaded. Click Run SQL to execute it.");
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
              {busy
                ? message === "Running SQL..."
                  ? "Running SQL..."
                  : "Asking..."
                : "Ask AI"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => runQuery()}
              disabled={busy || !sql.trim()}
            >
              Run SQL
            </button>
          </div>

          <label>
            SQL
            <textarea value={sql} onChange={(event) => setSql(event.target.value)} />
          </label>

          {message ? <p className={styles.message}>{message}</p> : null}
        </form>

        <ChartPanel rows={rows} busy={busy} />
        <ResultTable columns={columns} rows={rows} />
      </section>
    </main>
  );
}
