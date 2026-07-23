import { loadLlmConfig, isJsonModeCompatibilityError } from "../lib/llmConfig";
import { completeChat } from "../lib/llmClient";
import { parseLastJsonObject } from "../lib/jsonOutput";

async function main() {
  let config;
  try {
    config = loadLlmConfig();
  } catch (error: any) {
    console.error("Configuration error:", error.message);
    process.exit(1);
  }

  const start = Date.now();
  try {
    const rawResponse = await completeChat(
      [{ role: "user", content: 'Return exactly one JSON object with {"ok":true}.' }],
      {
        maxTokens: 100,
        temperature: 0,
        responseFormat: { type: "json_object" },
      },
      config,
    );

    const parsed = parseLastJsonObject(rawResponse);
    const latency = Date.now() - start;

    if (!parsed || parsed.ok !== true) {
      throw new Error(`Model returned unexpected JSON output: ${JSON.stringify(parsed)}`);
    }

    console.log(`Model: ${config.model}`);
    console.log(`Endpoint: ${config.baseURL}`);
    console.log(`Auth: ${config.authMode}`);
    console.log(`JSON mode: ${config.jsonMode}`);
    console.log(`Reasoning transport: ${config.reasoningTransport}`);
    console.log(`Result: compatible`);
    console.log(`Latency: ${latency} ms`);
  } catch (error: any) {
    const latency = Date.now() - start;
    console.error(`Result: incompatible`);
    console.error(`Error: ${error.message}`);
    console.error(`Latency: ${latency} ms`);

    if (config.jsonMode === "native" && isJsonModeCompatibilityError(error.message)) {
      console.error("\nThe endpoint rejected response_format.");
      console.error("Set LLM_JSON_MODE=prompt and run npm run model:check again.");
    }
    process.exit(1);
  }
}

main();
