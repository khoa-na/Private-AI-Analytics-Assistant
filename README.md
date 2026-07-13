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

2. Install one SQLite database as `data/active.db`. Optional dataset-specific
   context can be added as `data/dataset.md` and `data/semantic.json`.

   The database can also live elsewhere:

   ```bash
   ACTIVE_DATABASE_PATH=/path/to/database.sqlite
   ```

   For the included Olist CSV importer, put the CSV files in `data/` and run:

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
