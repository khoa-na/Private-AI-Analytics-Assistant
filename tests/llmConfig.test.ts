import {
  loadLlmConfig,
  isLlmConfigured,
  isJsonModeCompatibilityError,
} from "../lib/llmConfig";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertThrows(fn: () => void, expectedSnippet: string) {
  try {
    fn();
    throw new Error(`Expected error containing "${expectedSnippet}" but function succeeded.`);
  } catch (err: any) {
    if (!err.message.includes(expectedSnippet)) {
      throw new Error(`Expected error containing "${expectedSnippet}", got: "${err.message}"`);
    }
  }
}

// 1. Valid default configuration
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "gpt-4o",
    OPENAI_API_KEY: "secret-key",
  });
  assert(config.model === "gpt-4o", "model should be gpt-4o");
  assert(config.baseURL === "https://api.openai.com/v1", "default baseURL should be OpenAI");
  assert(config.authMode === "bearer", "default authMode should be bearer");
  assert(config.apiKey === "secret-key", "apiKey should match");
  assert(config.jsonMode === "native", "default jsonMode should be native");
  assert(config.reasoningTransport === "none", "default reasoningTransport should be none");
  assert(config.sendTemperature === true, "default sendTemperature should be true");
  assert(config.timeoutMs === 60000, "default timeoutMs should be 60000");
  assert(config.maxRetries === 1, "default maxRetries should be 1");
  assert(isLlmConfigured({ OPENAI_MODEL: "gpt-4o", OPENAI_API_KEY: "secret-key" }), "should be configured");
}

// 2. Bearer authentication without a key throws error
{
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "gpt-4o", LLM_AUTH_MODE: "bearer" }),
    "OPENAI_API_KEY is required when LLM_AUTH_MODE is bearer"
  );
  assert(!isLlmConfigured({ OPENAI_MODEL: "gpt-4o", LLM_AUTH_MODE: "bearer" }), "should not be configured");
}

// 3. No-auth local configuration without a key
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "llama3",
    OPENAI_BASE_URL: "http://localhost:11434/v1",
    LLM_AUTH_MODE: "none",
  });
  assert(config.model === "llama3", "model should be llama3");
  assert(config.authMode === "none", "authMode should be none");
  assert(config.apiKey === undefined, "apiKey should be undefined");
  assert(isLlmConfigured({ OPENAI_MODEL: "llama3", LLM_AUTH_MODE: "none" }), "should be configured without key");
}

// 4. Invalid base URL
{
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "ftp://example.com" }),
    "Base URL must use HTTP or HTTPS protocol"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "not-a-url" }),
    "Invalid OPENAI_BASE_URL"
  );
}

// 5. Invalid enum values
{
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_AUTH_MODE: "invalid" }),
    "Invalid LLM_AUTH_MODE"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_JSON_MODE: "invalid" }),
    "Invalid LLM_JSON_MODE"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_REASONING_TRANSPORT: "invalid" }),
    "Invalid LLM_REASONING_TRANSPORT"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", OPENAI_REASONING_EFFORT: "invalid" }),
    "Invalid OPENAI_REASONING_EFFORT"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_THINKING: "invalid" }),
    "Invalid LLM_THINKING"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_SEND_TEMPERATURE: "invalid" }),
    "Invalid LLM_SEND_TEMPERATURE"
  );
}

// 6. Invalid timeout & retry count
{
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_REQUEST_TIMEOUT_MS: "500" }),
    "Invalid LLM_REQUEST_TIMEOUT_MS"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_REQUEST_TIMEOUT_MS: "400000" }),
    "Invalid LLM_REQUEST_TIMEOUT_MS"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_MAX_RETRIES: "3" }),
    "Invalid LLM_MAX_RETRIES"
  );
  assertThrows(
    () => loadLlmConfig({ OPENAI_MODEL: "m", OPENAI_API_KEY: "k", LLM_MAX_RETRIES: "-1" }),
    "Invalid LLM_MAX_RETRIES"
  );
}

// 7. Legacy DeepSeek configuration selects deepseek transport and thinking
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "arbitrary-model-name",
    OPENAI_API_KEY: "key",
    DEEPSEEK_THINKING_MODE: "disabled",
  });
  assert(config.reasoningTransport === "deepseek", "DEEPSEEK_THINKING_MODE should select deepseek transport");
  assert(config.thinking === "disabled", "thinking should be disabled");
}

// 8. Legacy local chat-template configuration selects chat-template transport and thinking
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "local-model",
    LLM_AUTH_MODE: "none",
    OPENAI_CHAT_TEMPLATE_THINKING: "false",
  });
  assert(config.reasoningTransport === "chat-template", "OPENAI_CHAT_TEMPLATE_THINKING should select chat-template transport");
  assert(config.thinking === "disabled", "thinking should be disabled");
}

// 9. Legacy effort configuration selects effort transport and reasoningEffort
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "reasoning-model",
    OPENAI_API_KEY: "key",
    OPENAI_REASONING_EFFORT: "high",
  });
  assert(config.reasoningTransport === "effort", "OPENAI_REASONING_EFFORT should select effort transport");
  assert(config.reasoningEffort === "high", "reasoningEffort should be high");
}

// 10. Explicit precedence
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "model",
    OPENAI_API_KEY: "key",
    LLM_REASONING_TRANSPORT: "none",
    DEEPSEEK_THINKING_MODE: "disabled",
    OPENAI_REASONING_EFFORT: "high",
  });
  assert(config.reasoningTransport === "none", "explicit LLM_REASONING_TRANSPORT overrides legacy variables");
}

// 11. No capability inference from model name alone
{
  const config = loadLlmConfig({
    OPENAI_MODEL: "deepseek-v4-flash",
    OPENAI_API_KEY: "key",
  });
  assert(config.reasoningTransport === "none", "reasoningTransport should be none despite model name having deepseek");
  assert(config.thinking === undefined, "thinking should be undefined when not explicitly set");
}

// 12. isJsonModeCompatibilityError predicate testing
{
  assert(isJsonModeCompatibilityError("Unsupported parameter: response_format"), "positive response_format");
  assert(isJsonModeCompatibilityError("This model does not support structured output"), "positive structured output");
  assert(isJsonModeCompatibilityError("JSON mode is unavailable"), "positive JSON mode");
  assert(isJsonModeCompatibilityError("response format unsupported"), "positive response format");

  assert(!isJsonModeCompatibilityError("HTTP 400: model not found"), "negative model not found");
  assert(!isJsonModeCompatibilityError("HTTP 400: invalid max_tokens"), "negative invalid max_tokens");
  assert(!isJsonModeCompatibilityError("HTTP 400: invalid reasoning effort"), "negative invalid reasoning effort");
}

console.log("llmConfig tests passed");
