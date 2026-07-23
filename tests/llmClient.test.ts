import assert from "node:assert/strict";
import {
  completeChat,
  completeChatMessage,
  buildChatCompletionRequest,
  stageReasoningEffort,
  tokenBudget,
} from "../lib/llmClient";
import { loadLlmConfig } from "../lib/llmConfig";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalAuthMode = process.env.LLM_AUTH_MODE;
const originalJsonMode = process.env.LLM_JSON_MODE;
const originalReasoningTransport = process.env.LLM_REASONING_TRANSPORT;
const originalThinking = process.env.LLM_THINKING;
const originalReasoningEffort = process.env.OPENAI_REASONING_EFFORT;
const originalSendTemp = process.env.LLM_SEND_TEMPERATURE;
const originalTimeoutMs = process.env.LLM_REQUEST_TIMEOUT_MS;
const originalMaxRetries = process.env.LLM_MAX_RETRIES;

try {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  process.env.OPENAI_BASE_URL = "http://localhost:8080/v1/";
  delete process.env.LLM_AUTH_MODE;
  delete process.env.LLM_JSON_MODE;
  delete process.env.LLM_REASONING_TRANSPORT;
  delete process.env.LLM_THINKING;
  delete process.env.OPENAI_REASONING_EFFORT;
  delete process.env.LLM_SEND_TEMPERATURE;
  delete process.env.LLM_REQUEST_TIMEOUT_MS;
  delete process.env.LLM_MAX_RETRIES;

  // 1. tokenBudget & stageReasoningEffort checks
  process.env.TEST_TOKEN_BUDGET = "321";
  assert.equal(tokenBudget("TEST_TOKEN_BUDGET", 10), 321);
  process.env.TEST_TOKEN_BUDGET = "invalid";
  assert.equal(tokenBudget("TEST_TOKEN_BUDGET", 10), 10);
  delete process.env.TEST_TOKEN_BUDGET;

  process.env.TEST_REASONING_EFFORT = "medium";
  assert.equal(stageReasoningEffort("TEST_REASONING_EFFORT"), "medium");
  process.env.TEST_REASONING_EFFORT = "low";
  assert.equal(stageReasoningEffort("TEST_REASONING_EFFORT", true), "medium");
  process.env.TEST_REASONING_EFFORT = "high";
  assert.equal(stageReasoningEffort("TEST_REASONING_EFFORT", true), "high");
  process.env.TEST_REASONING_EFFORT = "xhigh";
  assert.equal(stageReasoningEffort("TEST_REASONING_EFFORT", true), "xhigh");
  process.env.TEST_REASONING_EFFORT = "max";
  assert.equal(stageReasoningEffort("TEST_REASONING_EFFORT", true), "max");
  delete process.env.TEST_REASONING_EFFORT;

  // 2. Native JSON profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "model-a",
      OPENAI_API_KEY: "key",
      LLM_JSON_MODE: "native",
      LLM_REASONING_TRANSPORT: "none",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });
    assert.deepEqual(req.response_format, { type: "json_object" });
    assert.equal(req.reasoning_effort, undefined);
    assert.equal(req.thinking, undefined);
  }

  // 3. Prompt JSON profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "model-b",
      OPENAI_API_KEY: "key",
      LLM_JSON_MODE: "prompt",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
      responseFormat: { type: "json_object" },
    });
    assert.equal(req.response_format, undefined, "prompt mode omits response_format");
  }

  // 4. DeepSeek profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "deepseek-v4-flash",
      OPENAI_API_KEY: "key",
      LLM_REASONING_TRANSPORT: "deepseek",
      LLM_THINKING: "disabled",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
      reasoningEffort: "low",
    });
    assert.deepEqual(req.thinking, { type: "disabled" });
    assert.equal(req.reasoning_effort, undefined, "deepseek transport does not send reasoning_effort");
  }

  // 4b. Legacy DeepSeek profile produces actual thinking=disabled request body
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "arbitrary-name",
      OPENAI_API_KEY: "key",
      DEEPSEEK_THINKING_MODE: "disabled",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
    });
    assert.deepEqual(req.thinking, { type: "disabled" }, "legacy DEEPSEEK_THINKING_MODE produces thinking disabled body");
  }

  // 5. Reasoning-effort profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "o3-mini",
      OPENAI_API_KEY: "key",
      LLM_REASONING_TRANSPORT: "effort",
      OPENAI_REASONING_EFFORT: "high",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
      reasoningEffort: "xhigh",
    });
    assert.equal(req.reasoning_effort, "xhigh", "options.reasoningEffort takes priority over config");

    const reqDefault = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
    });
    assert.equal(reqDefault.reasoning_effort, "high", "config.reasoningEffort used as fallback");
  }

  // 6. Local chat-template profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "local-llama",
      LLM_AUTH_MODE: "none",
      LLM_REASONING_TRANSPORT: "chat-template",
      LLM_THINKING: "enabled",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
    });
    assert.deepEqual(req.chat_template_kwargs, { enable_thinking: true });

    let sentHeaders: Record<string, string> = {};
    globalThis.fetch = async (_input, init) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    };
    await completeChatMessage([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config);
    assert.equal(sentHeaders["Authorization"], undefined, "no Auth header when authMode is none");
  }

  // 7. Temperature-disabled profile
  {
    const config = loadLlmConfig({
      OPENAI_MODEL: "o1",
      OPENAI_API_KEY: "key",
      LLM_SEND_TEMPERATURE: "false",
    });
    const req = buildChatCompletionRequest(config, [{ role: "user", content: "hi" }], {
      maxTokens: 100,
      temperature: 0,
    });
    assert.equal(req.temperature, undefined, "omits temperature when LLM_SEND_TEMPERATURE is false");
  }

  // 8. Retry behavior
  // A) 503 followed by 200 calls fetch twice and succeeds
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "503 Service Unavailable" } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "retried ok" } }] }), {
        status: 200,
      });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "1",
    });
    const res = await completeChat([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config);
    assert.equal(attempts, 2, "fetch called twice");
    assert.equal(res, "retried ok");
  }

  // B) 400 calls fetch once and fails immediately
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: "Bad Request" } }), {
        status: 400,
      });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "1",
    });
    await assert.rejects(
      () => completeChat([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config),
      /status 400/
    );
    assert.equal(attempts, 1, "fetch called only once on 400");
  }

  // C) Network error is retried
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
        status: 200,
      });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "1",
    });
    const res = await completeChat([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config);
    assert.equal(attempts, 2, "network error retried");
    assert.equal(res, "recovered");
  }

  // D) Fix 2: Confidentiality - non-JSON response body is not exposed in error
  {
    globalThis.fetch = async () => {
      return new Response("SENSITIVE_USER_PROMPT_DATA and private schema", { status: 500 });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "SUPER_SECRET_KEY_123",
      LLM_MAX_RETRIES: "0",
    });
    await assert.rejects(
      async () => {
        await completeChat(
          [{ role: "user", content: "SENSITIVE_USER_PROMPT_DATA" }],
          { maxTokens: 10, temperature: 0 },
          config
        );
      },
      (err: any) => {
        assert(!err.message.includes("SUPER_SECRET_KEY_123"), "Error must not contain API key");
        assert(!err.message.includes("SENSITIVE_USER_PROMPT_DATA"), "Error must not contain prompt content or body");
        assert(!err.message.includes("private schema"), "Error must not contain body text");
        assert(err.message.includes("status 500"), "Error should include HTTP status");
        return true;
      }
    );
  }

  // E) Fix 2: Bounded structured error message retention
  {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "model unavailable" } }), { status: 503 });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "0",
    });
    await assert.rejects(
      async () => {
        await completeChat([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config);
      },
      (err: any) => {
        assert(err.message.includes("model unavailable"), "Error retains structured error message");
        return true;
      }
    );
  }

  // E2) HTTP 200 provider errors are sanitized and not retried
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          error: {
            message: "Rejected request: SENSITIVE_USER_PROMPT_DATA",
          },
        }),
        { status: 200 },
      );
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "1",
    });
    await assert.rejects(
      async () => {
        await completeChat(
          [{ role: "user", content: "SENSITIVE_USER_PROMPT_DATA" }],
          { maxTokens: 10, temperature: 0 },
          config,
        );
      },
      (err: any) => {
        assert(err.message.includes("Provider returned error"), "Error identifies provider failure");
        assert(!err.message.includes("SENSITIVE_USER_PROMPT_DATA"), "Error must redact echoed prompt");
        assert(err.message.includes("[redacted]"), "Error keeps a safe provider diagnostic");
        return true;
      },
    );
    assert.equal(attempts, 1, "HTTP 200 provider errors must not be retried");
  }

  // F) Fix 4: Reject choice without a message without retrying
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop" }] }), { status: 200 });
    };
    const config = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_MAX_RETRIES: "1",
    });
    await assert.rejects(
      async () => {
        await completeChatMessage([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, config);
      },
      /choice without a message/
    );
    assert.equal(attempts, 1, "choice without a message must not be retried");
  }

  // G) Fix 5: Timeout unit coverage
  {
    globalThis.fetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        const keepAlive = setInterval(() => {}, 50);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearInterval(keepAlive);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });

    const timeoutConfig = loadLlmConfig({
      OPENAI_MODEL: "test",
      OPENAI_API_KEY: "key",
      LLM_REQUEST_TIMEOUT_MS: "1000",
      LLM_MAX_RETRIES: "0",
    });

    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await completeChat([{ role: "user", content: "hi" }], { maxTokens: 10, temperature: 0 }, timeoutConfig);
      },
      (err: any) => {
        const elapsed = Date.now() - startTime;
        assert(elapsed >= 800, `elapsed ${elapsed}ms should be at least ~900ms`);
        assert(err.message.includes("aborted") || err.message.includes("timeout") || err.message.includes("Timeout"), "error mentions timeout");
        assert(err.message.includes("attempt 1/1"), "error mentions attempt 1/1");
        return true;
      }
    );
  }
} finally {
  globalThis.fetch = originalFetch;
  restoreEnvironment("OPENAI_API_KEY", originalApiKey);
  restoreEnvironment("OPENAI_MODEL", originalModel);
  restoreEnvironment("OPENAI_BASE_URL", originalBaseUrl);
  restoreEnvironment("LLM_AUTH_MODE", originalAuthMode);
  restoreEnvironment("LLM_JSON_MODE", originalJsonMode);
  restoreEnvironment("LLM_REASONING_TRANSPORT", originalReasoningTransport);
  restoreEnvironment("LLM_THINKING", originalThinking);
  restoreEnvironment("OPENAI_REASONING_EFFORT", originalReasoningEffort);
  restoreEnvironment("LLM_SEND_TEMPERATURE", originalSendTemp);
  restoreEnvironment("LLM_REQUEST_TIMEOUT_MS", originalTimeoutMs);
  restoreEnvironment("LLM_MAX_RETRIES", originalMaxRetries);
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("llmClient tests passed");
