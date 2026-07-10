import type { Row } from "@/lib/analyticsTypes";
import styles from "@/app/page.module.css";

type Props = {
  columns: string[];
  rows: Row[];
};

export function ResultTable({ columns, rows }: Props) {
  return (
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
  );
}
