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
import type { Row } from "@/lib/analyticsTypes";
import styles from "@/app/page.module.css";

export function ChartPanel({ rows }: { rows: Row[] }) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const yKey = columns.find((key) =>
    rows.some((row) => typeof row[key] === "number"),
  );
  const xKey = columns.find((column) => column !== yKey);

  if (!rows.length || !xKey || !yKey) {
    return (
      <div className={styles.panel}>
        <h2>Visualization</h2>
        <div className={styles.empty}>No chart available for this result.</div>
      </div>
    );
  }

  const isTime = /month|date|time|timestamp/i.test(xKey);
  const Chart = isTime ? LineChart : BarChart;

  return (
    <div className={styles.panel}>
      <h2>Visualization</h2>
      <ResponsiveContainer width="100%" height={320}>
        <Chart data={rows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xKey} minTickGap={24} />
          <YAxis />
          <Tooltip />
          {isTime ? (
            <Line dataKey={yKey} stroke="#0f766e" strokeWidth={2} dot={false} />
          ) : (
            <Bar dataKey={yKey} fill="#0f766e" />
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}
