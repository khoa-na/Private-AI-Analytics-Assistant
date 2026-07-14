# Private AI Analytics Assistant

Portfolio project for an AI engineer: a TypeScript web app that turns business
questions into safe SQL, executes them on one active SQLite dataset, and
visualizes grounded results.

## Stack

- Next.js + TypeScript
- SQLite with Node's built-in `node:sqlite`
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

2. Import a SQLite file or a directory of CSV/TSV files:

   ```bash
   npm run dataset:import -- /path/to/database.sqlite
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
       "sourceColumn": "source_file",
       "indexes": [["flight_date"], ["carrier", "flight_date"]]
     }]
   }
   ```

   After changing indexes or AI configuration, refresh metadata without
   importing the raw files again:

   ```bash
   npm run dataset:import -- /path/to/dataset-directory --refresh
   ```

   The command stages `database.sqlite`, a privacy-filtered `dataset-profile.json`,
   full `dataset-catalog.json` and `dataset.md`, compact `dataset.runtime.md`,
   and `semantic.json` under `data/staging/<name>`. When an LLM is configured it
   enriches the draft; otherwise the guide is generated deterministically.
   The versioned semantic draft records provenance and validation for every
   entity, relationship candidate, and measure candidate. Review the draft,
   move confirmed relationship objects into `relationships`, move confirmed
   measure objects into `measures` keyed by measure name, preserve their
   provenance and validation fields,
   set `semantic.json` status to `approved`, stop the development server, then run:

   ```bash
   npm run dataset:activate -- <name>
   ```

   Activation moves the complete bundle under `data/active/` and removes the old
   active bundle, avoiding a second copy of large databases. Existing installations
   using `data/active.db`, `data/dataset.md`, and `data/semantic.json` remain supported.
   Remove old `ACTIVE_*` dataset overrides from `.env.local`, or point them at this bundle.

   The database can also live elsewhere:

   ```bash
   ACTIVE_DATABASE_PATH=/path/to/database.sqlite
   ```

   For the legacy Olist-specific importer, put the CSV files in `data/` and run:

   ```bash
   npm run build-db
   ```

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
