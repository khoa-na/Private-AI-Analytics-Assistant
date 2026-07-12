import type { Analysis } from "@/lib/analyticsTypes";
import styles from "@/app/page.module.css";

export function InsightPanel({
  analysis,
  aiAnalysis,
  canGenerateInsights,
  insightsBusy,
  onGenerateInsights,
}: {
  analysis: Analysis | null;
  aiAnalysis: Analysis | null;
  canGenerateInsights: boolean;
  insightsBusy: boolean;
  onGenerateInsights: () => void;
}) {
  if (!analysis) return null;

  return (
    <section className={styles.panel}>
      <h2>Analysis</h2>
      <p>{analysis.summary}</p>
      {analysis.insights.map((insight, index) => (
        <div key={index}>
          <strong>{insight.statement}</strong>
          <ul>
            {insight.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
        </div>
      ))}
      {analysis.caveats.length ? (
        <p className={styles.message}>Caveats: {analysis.caveats.join(" ")}</p>
      ) : null}
      {canGenerateInsights && !aiAnalysis ? (
        <button type="button" onClick={onGenerateInsights} disabled={insightsBusy}>
          {insightsBusy ? "Generating insights..." : "Generate AI insights"}
        </button>
      ) : null}
      {aiAnalysis ? (
        <div>
          <h3>AI insights</h3>
          <p>{aiAnalysis.summary}</p>
          {aiAnalysis.insights.map((insight, index) => (
            <div key={index}>
              <strong>{insight.statement}</strong>
              <ul>
                {insight.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ul>
            </div>
          ))}
          {aiAnalysis.caveats.length ? (
            <p className={styles.message}>Caveats: {aiAnalysis.caveats.join(" ")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
