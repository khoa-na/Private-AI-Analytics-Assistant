import assert from "node:assert/strict";
import { completeChat, completeChatMessage, stageReasoningEffort, tokenBudget } from "../lib/llmClient";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

try {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  process.env.OPENAI_BASE_URL = "http://localhost:8080/v1/";
  process.env.TEST_TOKEN_BUDGET = "321";
  assert.equal(tokenBudget("TEST_TOKEN_BUDGET", 10), 321);
  process.env.TEST_TOKEN_BUDGET = "invalid";
  assert.equal(tokenBudget("TEST_TOKEN_BUDGET", 10), 10);
  delete process.env.TEST_TOKEN_BUDGET;
  process.env.OPENAI_PLAN_REASONING_EFFORT = "medium";
  assert.equal(stageReasoningEffort("OPENAI_PLAN_REASONING_EFFORT"), "medium");
  process.env.OPENAI_PLAN_REASONING_EFFORT = "low";
  assert.equal(stageReasoningEffort("OPENAI_PLAN_REASONING_EFFORT", true), "medium");
  delete process.env.OPENAI_PLAN_REASONING_EFFORT;

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
      model: "review-model",
      responseFormat: { type: "json_object", schema: { type: "object" } },
    }),
    "SELECT 1",
  );
  assert.equal(requestBody?.model, "review-model");
  assert.equal(requestBody?.max_tokens, 123);
  assert.deepEqual(requestBody?.response_format, {
    type: "json_object",
    schema: { type: "object" },
  });
  assert.deepEqual(requestBody?.chat_template_kwargs, {
    enable_thinking: false,
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: { content: "", reasoning_content: "unfinished reasoning" },
          },
        ],
      }),
      { status: 200 },
    );
  await assert.rejects(
    () =>
      completeChat([{ role: "user", content: "test" }], {
        maxTokens: 10,
        temperature: 0,
        responseFormat: { type: "json_object" },
      }),
    /exhausted its token budget/,
  );

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "", reasoning_content: '{"intent":"query"}' },
          },
        ],
      }),
      { status: 200 },
    );
  assert.equal(
    await completeChat([{ role: "user", content: "test" }], {
      maxTokens: 10,
      temperature: 0,
      responseFormat: { type: "json_object" },
    }),
    '{"intent":"query"}',
  );

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "get_dataset_guide",
                    arguments: { dataset: "olist" },
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const toolMessage = await completeChatMessage(
    [{ role: "user", content: "load guide" }],
    {
      maxTokens: 50,
      temperature: 0,
      tools: [
        {
          type: "function",
          function: {
            name: "get_dataset_guide",
            description: "Load guide",
            parameters: { type: "object" },
          },
        },
      ],
      toolChoice: "required",
    },
  );
  assert.equal(toolMessage?.tool_calls?.[0].function.name, "get_dataset_guide");
  assert.equal(requestBody?.tool_choice, "required");

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
