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
import type { ChartSpec, Row } from "@/lib/analyticsTypes";
import styles from "@/app/page.module.css";

export function ChartPanel({
  rows,
  busy,
  chart,
}: {
  rows: Row[];
  busy: boolean;
  chart?: ChartSpec;
}) {
  const yKey = chart?.yKeys?.[0];
  const xKey = chart?.xKey;

  if (!rows.length || !chart || chart.type === "none" || !xKey || !yKey) {
    return (
      <div className={styles.panel}>
        <h2>Recommended visualization</h2>
        <div className={styles.empty}>
          {busy
            ? "Waiting for query results..."
            : chart?.reason ?? "No chart available for this result."}
        </div>
      </div>
    );
  }

  const isTime = chart.type === "line";
  const Chart = isTime ? LineChart : BarChart;

  return (
    <div className={styles.panel}>
      <h2>Recommended visualization</h2>
      <p>{chart.reason}</p>
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
