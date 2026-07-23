export type JsonMode = "native" | "prompt";

export type ReasoningTransport =
  | "none"
  | "effort"
  | "deepseek"
  | "chat-template";

export type AuthMode = "bearer" | "none";

export type ReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type LlmConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  authMode: AuthMode;
  jsonMode: JsonMode;
  reasoningTransport: ReasoningTransport;
  reasoningEffort?: ReasoningEffort;
  thinking?: "enabled" | "disabled";
  sendTemperature: boolean;
  timeoutMs: number;
  maxRetries: number;
};

function legacyReasoningTransport(
  env: Record<string, string | undefined>
): ReasoningTransport {
  if (env.DEEPSEEK_THINKING_MODE !== undefined) return "deepseek";
  if (env.OPENAI_CHAT_TEMPLATE_THINKING !== undefined) return "chat-template";
  if (env.OPENAI_REASONING_EFFORT !== undefined) return "effort";
  return "none";
}

export function isJsonModeCompatibilityError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("response_format") ||
    normalized.includes("response format") ||
    normalized.includes("json mode") ||
    normalized.includes("structured output")
  );
}

export function loadLlmConfig(
  env?: Record<string, string | undefined>
): LlmConfig {
  const e = env ?? process.env;

  const model = e.OPENAI_MODEL?.trim();
  if (!model) {
    throw new Error("OPENAI_MODEL is required.");
  }

  const rawBaseURL = e.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  let baseURL: string;
  try {
    const parsedUrl = new URL(rawBaseURL);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Base URL must use HTTP or HTTPS protocol.");
    }
    baseURL = rawBaseURL;
  } catch (err: any) {
    if (err.message === "Base URL must use HTTP or HTTPS protocol.") {
      throw err;
    }
    throw new Error(`Invalid OPENAI_BASE_URL: "${rawBaseURL}".`);
  }

  const authModeRaw = e.LLM_AUTH_MODE?.trim() || "bearer";
  if (authModeRaw !== "bearer" && authModeRaw !== "none") {
    throw new Error(`Invalid LLM_AUTH_MODE: "${authModeRaw}". Must be "bearer" or "none".`);
  }
  const authMode: AuthMode = authModeRaw;

  const apiKey = e.OPENAI_API_KEY?.trim();
  if (authMode === "bearer" && !apiKey) {
    throw new Error("OPENAI_API_KEY is required when LLM_AUTH_MODE is bearer.");
  }

  const jsonModeRaw = e.LLM_JSON_MODE?.trim() || "native";
  if (jsonModeRaw !== "native" && jsonModeRaw !== "prompt") {
    throw new Error(`Invalid LLM_JSON_MODE: "${jsonModeRaw}". Must be "native" or "prompt".`);
  }
  const jsonMode: JsonMode = jsonModeRaw;

  const reasoningTransportRaw =
    e.LLM_REASONING_TRANSPORT?.trim() || legacyReasoningTransport(e);
  if (
    reasoningTransportRaw !== "none" &&
    reasoningTransportRaw !== "effort" &&
    reasoningTransportRaw !== "deepseek" &&
    reasoningTransportRaw !== "chat-template"
  ) {
    throw new Error(
      `Invalid LLM_REASONING_TRANSPORT: "${reasoningTransportRaw}". Must be "none", "effort", "deepseek", or "chat-template".`
    );
  }
  const reasoningTransport: ReasoningTransport = reasoningTransportRaw;

  let reasoningEffort: ReasoningEffort | undefined;
  if (e.OPENAI_REASONING_EFFORT) {
    const rawEffort = e.OPENAI_REASONING_EFFORT.trim();
    if (["low", "medium", "high", "xhigh", "max"].includes(rawEffort)) {
      reasoningEffort = rawEffort as ReasoningEffort;
    } else {
      throw new Error(
        `Invalid OPENAI_REASONING_EFFORT: "${rawEffort}". Must be "low", "medium", "high", "xhigh", or "max".`
      );
    }
  }

  let thinking: "enabled" | "disabled" | undefined;
  if (e.LLM_THINKING) {
    const rawThinking = e.LLM_THINKING.trim();
    if (rawThinking === "enabled" || rawThinking === "disabled") {
      thinking = rawThinking;
    } else {
      throw new Error(`Invalid LLM_THINKING: "${rawThinking}". Must be "enabled" or "disabled".`);
    }
  } else if (e.DEEPSEEK_THINKING_MODE) {
    const rawThinking = e.DEEPSEEK_THINKING_MODE.trim();
    if (rawThinking === "enabled" || rawThinking === "disabled") {
      thinking = rawThinking;
    } else {
      throw new Error(`Invalid DEEPSEEK_THINKING_MODE: "${rawThinking}". Must be "enabled" or "disabled".`);
    }
  } else if (reasoningTransport === "chat-template" && e.OPENAI_CHAT_TEMPLATE_THINKING) {
    const rawThinking = e.OPENAI_CHAT_TEMPLATE_THINKING.trim();
    if (rawThinking === "true") {
      thinking = "enabled";
    } else if (rawThinking === "false") {
      thinking = "disabled";
    } else {
      throw new Error(`Invalid OPENAI_CHAT_TEMPLATE_THINKING: "${rawThinking}". Must be "true" or "false".`);
    }
  }

  let sendTemperature = true;
  if (e.LLM_SEND_TEMPERATURE !== undefined) {
    const rawSendTemp = e.LLM_SEND_TEMPERATURE.trim();
    if (rawSendTemp === "true") {
      sendTemperature = true;
    } else if (rawSendTemp === "false") {
      sendTemperature = false;
    } else {
      throw new Error(`Invalid LLM_SEND_TEMPERATURE: "${rawSendTemp}". Must be "true" or "false".`);
    }
  }

  let timeoutMs = 60000;
  if (e.LLM_REQUEST_TIMEOUT_MS !== undefined) {
    const val = Number(e.LLM_REQUEST_TIMEOUT_MS.trim());
    if (!Number.isInteger(val) || val < 1000 || val > 300000) {
      throw new Error(
        `Invalid LLM_REQUEST_TIMEOUT_MS: "${e.LLM_REQUEST_TIMEOUT_MS}". Must be an integer between 1000 and 300000.`
      );
    }
    timeoutMs = val;
  }

  let maxRetries = 1;
  if (e.LLM_MAX_RETRIES !== undefined) {
    const val = Number(e.LLM_MAX_RETRIES.trim());
    if (!Number.isInteger(val) || val < 0 || val > 2) {
      throw new Error(
        `Invalid LLM_MAX_RETRIES: "${e.LLM_MAX_RETRIES}". Must be an integer between 0 and 2.`
      );
    }
    maxRetries = val;
  }

  return {
    baseURL,
    apiKey: apiKey || undefined,
    model,
    authMode,
    jsonMode,
    reasoningTransport,
    reasoningEffort,
    thinking,
    sendTemperature,
    timeoutMs,
    maxRetries,
  };
}

export function isLlmConfigured(
  env?: Record<string, string | undefined>
): boolean {
  try {
    loadLlmConfig(env);
    return true;
  } catch {
    return false;
  }
}
