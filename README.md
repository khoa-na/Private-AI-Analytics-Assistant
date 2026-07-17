# Private AI Analytics Assistant

Portfolio project for an AI engineer: a TypeScript web app that turns business
questions into safe SQL, executes them on one active DuckDB dataset, and
visualizes grounded results.

## Stack

- Next.js + TypeScript
- DuckDB with the official `@duckdb/node-api` client
- OpenAI-compatible LLM API
- `node-sql-parser` for read-only SQL validation
- Recharts for visualization

## MVP

- Inspect the active database schema.
- Ask a business question in natural language.
- Generate SQL with schema context.
- Block unsafe SQL before execution.
- Show SQL, result table, and a recommended chart.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Import a DuckDB file or a directory of CSV/TSV/Parquet files:

   ```bash
   npm run dataset:import -- /path/to/database.duckdb
   npm run dataset:import -- /path/to/csv-directory --name=sales
   npm run dataset:import -- /path/to/private-data --no-ai
   ```

   Files are separate tables by default. To union files or declare keys, add
   `dataset.json` inside the source directory:

   ```json
   {
     "name": "flights",
     "llmPolicy": {
       "sendExamples": true,
       "sendFreeTextExamples": false,
       "maskIdentifiers": true,
       "maxExampleLength": 80
     },
     "tables": [{
       "name": "flights",
       "format": "csv",
       "sources": ["*.csv"],
       "sourceColumn": "source_file"
     }]
   }
   ```

   After changing the manifest or AI configuration, rebuild the staged bundle:

   ```bash
   npm run dataset:import -- /path/to/dataset-directory --refresh
   ```

   The command stages `database.duckdb`, a privacy-filtered `dataset-profile.json`,
   full `dataset-catalog.json` and `dataset.md`, compact `dataset.runtime.md`,
   `semantic.json`, and `bundle-manifest.json` under `data/staging/<name>`.
   The bundle manifest fingerprints the database schema and every generated
   artifact, so activation rejects stale or mixed files. When an LLM is configured
   it enriches the draft; otherwise the guide is generated deterministically.
   The versioned semantic draft records provenance and validation for every
   entity, relationship candidate, and measure candidate. Review it through the
   independent approval pipeline:

   ```bash
   npm run dataset:review -- <name>
   npm run dataset:review -- <name> --no-ai
   ```

   Review opens DuckDB read-only, verifies inferred relationships against
   the full database, revalidates measure SQL, writes `review-report.json`, and
   seals the reviewed semantic fingerprint. The reviewer receives anonymous
   measure IDs, SQL, columns, and evidence IDs; it never receives draft names,
   descriptions, grain, or generation reasoning. It can only approve or reject.
   Code generates neutral names and wording after the verdict. `OPENAI_MODEL` is
   reused by default; `OPENAI_REVIEW_MODEL` remains an optional model override.
   `--no-ai` conservatively excludes LLM-only measures. Bundle states are limited
   to `draft -> approved/rejected -> active`.

   After approval, stop the development server and run:

   ```bash
   npm run dataset:activate -- <name>
   ```

   Activation requires an `approved` bundle, validates every fingerprint,
   verifies that DuckDB opens and its catalog is readable, then moves
   the complete bundle under `data/active/`. Interrupted `active.next` and
   `active.previous` swaps are recovered on the next activation before the bundle
   transitions to `active`. The old active
   bundle is removed, avoiding a second copy of large databases.
   Remove old `ACTIVE_*` dataset overrides from `.env.local`, or point them at this bundle.

   The database can also live elsewhere:

   ```bash
   ACTIVE_DATABASE_PATH=/path/to/database.duckdb
   ```

   For the legacy Olist-specific importer, put the CSV files in
   `data/olist/raw/` and run:

   ```bash
   npm run build-db
   ```

   This creates `data/olist/database.duckdb` without changing the active dataset.

3. Add local environment variables:

   ```bash
   cp .env.example .env.local
   ```

4. Configure any OpenAI-compatible provider through `OPENAI_BASE_URL`,
   `OPENAI_API_KEY`, and `OPENAI_MODEL`.

5. Run the app:

   ```bash
   npm run dev
   ```

   Open `http://localhost:4000`.

The app introspects tables, column types, primary keys, and declared foreign
keys at runtime. Replacing the active database does not require code changes.
The `data/` directory is ignored by Git because datasets should stay local.

## Product Roadmap

See the [AI analytics roadmap](./docs/AI_ANALYTICS_ROADMAP.md) for the phased
plan to evolve this text-to-SQL MVP into a grounded, conversational AI data
analyst.
