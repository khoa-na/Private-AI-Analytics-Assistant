# Private AI Analytics Assistant

Portfolio project for an AI engineer: a TypeScript web app that turns business
questions into safe SQL, executes them on the Olist ecommerce dataset, and
visualizes the result.

## Stack

- Next.js + TypeScript
- SQLite with Node's built-in `node:sqlite`
- OpenAI-compatible LLM API
- `node-sql-parser` for read-only SQL validation
- Recharts for visualization

## MVP

- Inspect the ecommerce database schema.
- Ask a business question in natural language.
- Generate SQL with schema context.
- Block unsafe SQL before execution.
- Show SQL, result table, and a recommended chart.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Put the Olist CSV files in `data/`.

3. Build the local SQLite database:

   ```bash
   npm run build-db
   ```

4. Add local environment variables:

   ```bash
   cp .env.example .env.local
   ```

5. Start a local llama.cpp server:

   ```bash
   llama serve -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL
   ```

   The app expects the OpenAI-compatible endpoint at
   `http://127.0.0.1:8080/v1`. You can also point `OPENAI_BASE_URL` at another
   OpenAI-compatible provider.

6. Run the app:

   ```bash
   npm run dev
   ```

The `data/` directory is ignored by Git because the Kaggle files and generated
database should stay local.
