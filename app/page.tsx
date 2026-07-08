"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "./page.module.css";

type Schema = Record<string, string[]>;
type Row = Record<string, string | number | null>;

const EXAMPLES = [
  {
    label: "Monthly revenue",
    question: "What is monthly delivered revenue?",
    sql: `SELECT
  strftime('%Y-%m', o.order_purchase_timestamp) AS month,
  ROUND(SUM(CAST(oi.price AS REAL) + CAST(oi.freight_value AS REAL)), 2) AS revenue
FROM orders o
JOIN order_items oi ON o.order_id = oi.order_id
WHERE o.order_status = 'delivered'
GROUP BY month
ORDER BY month`,
  },
  {
    label: "Top categories",
    question: "Which product categories generated the most sales?",
    sql: `SELECT
  COALESCE(t.product_category_name_english, p.product_category_name) AS category,
  ROUND(SUM(CAST(oi.price AS REAL)), 2) AS sales
FROM order_items oi
JOIN products p ON oi.product_id = p.product_id
LEFT JOIN category_translation t
  ON p.product_category_name = t.product_category_name
GROUP BY category
ORDER BY sales DESC
LIMIT 15`,
  },
  {
    label: "Review by payment",
    question: "What is the average review score by payment type?",
    sql: `SELECT
  pay.payment_type,
  ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score,
  COUNT(*) AS orders
FROM order_payments pay
JOIN order_reviews r ON pay.order_id = r.order_id
GROUP BY pay.payment_type
ORDER BY avg_review_score DESC`,
  },
  {
    label: "Lowest reviewed categories",
    question: "Danh mục sản phẩm nào có điểm đánh giá trung bình thấp nhất?",
    sql: `SELECT
  COALESCE(t.product_category_name_english, p.product_category_name) AS category,
  ROUND(AVG(CAST(r.review_score AS REAL)), 2) AS avg_review_score,
  COUNT(DISTINCT r.order_id) AS reviewed_orders
FROM order_reviews r
JOIN order_items oi ON r.order_id = oi.order_id
JOIN products p ON oi.product_id = p.product_id
LEFT JOIN category_translation t
  ON p.product_category_name = t.product_category_name
GROUP BY category
HAVING reviewed_orders >= 20
ORDER BY avg_review_score ASC, reviewed_orders DESC
LIMIT 15`,
  },
];

function numericColumns(rows: Row[]) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).filter((key) =>
    rows.some((row) => typeof row[key] === "number"),
  );
}

function Chart({ rows }: { rows: Row[] }) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const yKey = numericColumns(rows)[0];
  const xKey = columns.find((column) => column !== yKey);

  if (!rows.length || !xKey || !yKey) {
    return <div className={styles.empty}>No chart available for this result.</div>;
  }

  const isTime = /month|date|time|timestamp/i.test(xKey);
  const ChartComponent = isTime ? LineChart : BarChart;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ChartComponent data={rows}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xKey} minTickGap={24} />
        <YAxis />
        <Tooltip />
        {isTime ? (
          <Line dataKey={yKey} stroke="#0f766e" strokeWidth={2} dot={false} />
        ) : (
          <Bar dataKey={yKey} fill="#0f766e" />
        )}
      </ChartComponent>
    </ResponsiveContainer>
  );
}

export default function Home() {
  const [schema, setSchema] = useState<Schema>({});
  const [question, setQuestion] = useState(EXAMPLES[0].question);
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const tableEntries = useMemo(() => Object.entries(schema), [schema]);

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
    setMessage("");
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
      <aside className={styles.sidebar}>
        <h1>SQL AI Assistant</h1>
        <p>Olist ecommerce analytics with safe SQL and automatic charts.</p>

        <section>
          <h2>Schema</h2>
          <div className={styles.schemaList}>
            {tableEntries.map(([table, cols]) => (
              <details key={table}>
                <summary>{table}</summary>
                <p>{cols.join(", ")}</p>
              </details>
            ))}
          </div>
        </section>
      </aside>

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
              {busy ? "Asking..." : "Ask AI"}
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

        <div className={styles.panel}>
          <h2>Visualization</h2>
          <Chart rows={rows} />
        </div>

        <div className={styles.panel}>
          <h2>Results</h2>
          <div className={styles.tableWrap}>
            {rows.length ? (
              <table>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      {columns.map((column) => (
                        <td key={column}>{String(row[column] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className={styles.empty}>Run a query to see results.</div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
