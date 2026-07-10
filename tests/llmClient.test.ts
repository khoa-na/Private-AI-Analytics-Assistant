import assert from "node:assert/strict";
import { completeChat } from "../lib/llmClient";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

try {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  process.env.OPENAI_BASE_URL = "http://localhost:8080/v1/";

  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "SELECT 1" } }] }),
      { status: 200 },
    );
  };

  assert.equal(
    await completeChat([{ role: "user", content: "test" }], {
      maxTokens: 123,
      temperature: 0.2,
      responseFormat: { type: "json_object", schema: { type: "object" } },
    }),
    "SELECT 1",
  );
  assert.equal(requestBody?.model, "test-model");
  assert.equal(requestBody?.max_tokens, 123);
  assert.deepEqual(requestBody?.response_format, {
    type: "json_object",
    schema: { type: "object" },
  });
  assert.deepEqual(requestBody?.chat_template_kwargs, {
    enable_thinking: false,
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
      status: 503,
    });
  await assert.rejects(
    () =>
      completeChat([{ role: "user", content: "test" }], {
        maxTokens: 10,
        temperature: 0,
      }),
    /model unavailable/,
  );
} finally {
  globalThis.fetch = originalFetch;
  restoreEnvironment("OPENAI_API_KEY", originalApiKey);
  restoreEnvironment("OPENAI_MODEL", originalModel);
  restoreEnvironment("OPENAI_BASE_URL", originalBaseUrl);
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("llmClient tests passed");
