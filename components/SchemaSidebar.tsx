import type { Schema } from "@/lib/analyticsTypes";
import styles from "@/app/page.module.css";

export function SchemaSidebar({ schema }: { schema: Schema }) {
  return (
    <aside className={styles.sidebar}>
      <h1>Private AI Analytics Assistant</h1>
      <p>Olist ecommerce analytics with safe SQL and automatic charts.</p>

      <section>
        <h2>Schema</h2>
        <div className={styles.schemaList}>
          {Object.entries(schema).map(([table, columns]) => (
            <details key={table}>
              <summary>{table}</summary>
              <p>{columns.join(", ")}</p>
            </details>
          ))}
        </div>
      </section>
    </aside>
  );
}
