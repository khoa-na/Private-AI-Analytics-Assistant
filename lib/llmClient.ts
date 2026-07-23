import { loadLlmConfig, LlmConfig, ReasoningEffort } from "./llmConfig";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string | Record<string, unknown> };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionOptions = {
  maxTokens: number;
  temperature: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: Record<string, unknown>;
  tools?: ChatTool[];
  toolChoice?: string | Record<string, unknown>;
};

export function stageReasoningEffort(name: string, retry = false) {
  const value = process.env[name] ?? process.env.OPENAI_REASONING_EFFORT;
  const effort = ["low", "medium", "high", "xhigh", "max"].includes(value ?? "")
    ? (value as ReasoningEffort)
    : undefined;
  return retry && effort === "low" ? "medium" : effort;
}

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: { message?: string };
};

function safeProviderMessage(
  completion: ChatCompletionResponse | undefined,
  messages: ChatMessage[],
): string | undefined {
  const message = completion?.error?.message;
  if (typeof message !== "string") return undefined;
  let sanitized = message.replace(/\s+/g, " ").trim();
  for (const item of messages) {
    const content = item.content?.replace(/\s+/g, " ").trim();
    if (content) sanitized = sanitized.replaceAll(content, "[redacted]");
  }
  return sanitized.slice(0, 200) || undefined;
}

export function tokenBudget(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function buildChatCompletionRequest(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions,
): Record<string, unknown> {
  const model = options.model ?? config.model;
  const req: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens,
  };

  if (config.sendTemperature) {
    req.temperature = options.temperature;
  }

  if (options.responseFormat && config.jsonMode === "native") {
    req.response_format = options.responseFormat;
  }

  if (config.reasoningTransport === "effort") {
    const effort = options.reasoningEffort ?? config.reasoningEffort;
    if (effort) {
      req.reasoning_effort = effort;
    }
  } else if (config.reasoningTransport === "deepseek") {
    req.thinking = { type: config.thinking ?? "disabled" };
  } else if (config.reasoningTransport === "chat-template") {
    req.chat_template_kwargs = {
      enable_thinking: config.thinking === "enabled",
    };
  }

  if (options.tools) {
    req.tools = options.tools;
  }

  if (options.toolChoice) {
    req.tool_choice = options.toolChoice;
  }

  return req;
}

export async function completeChatMessage(
  messages: ChatMessage[],
  options: ChatCompletionOptions,
  overrideConfig?: LlmConfig,
) {
  const config = overrideConfig ?? loadLlmConfig();
  const reqBody = buildChatCompletionRequest(config, messages, options);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.authMode === "bearer" && config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const url = `${config.baseURL.replace(/\/$/, "")}/chat/completions`;
  const maxAttempts = 1 + config.maxRetries;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const signal = AbortSignal.timeout(config.timeoutMs);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
        signal,
      });

      let completion: ChatCompletionResponse | undefined;
      let textBody = "";
      try {
        textBody = await response.text();
        if (textBody) {
          completion = JSON.parse(textBody);
        }
      } catch {
        if (response.ok) {
          throw new Error(
            `Provider response was not valid JSON (attempt ${attempt}/${maxAttempts}).`
          );
        }
      }

      if (!response.ok) {
        const status = response.status;
        const providerMessage = safeProviderMessage(completion, messages);
        const suffix = providerMessage ? `: ${providerMessage}` : "";
        const shouldRetryStatus = [408, 429, 500, 502, 503, 504].includes(status);
        const errMsg = `AI request failed (status ${status}, attempt ${attempt}/${maxAttempts})${suffix}`;
        const err = new Error(errMsg);

        if (shouldRetryStatus && attempt < maxAttempts) {
          lastError = err;
          continue;
        }
        throw err;
      }

      if (!completion) {
        throw new Error(
          `Provider response was not valid JSON (attempt ${attempt}/${maxAttempts}).`
        );
      }

      if (completion.error?.message) {
        const providerMessage = safeProviderMessage(completion, messages);
        const suffix = providerMessage ? `: ${providerMessage}` : "";
        throw new Error(
          `Provider returned error (attempt ${attempt}/${maxAttempts})${suffix}`
        );
      }

      if (!completion.choices || completion.choices.length === 0) {
        throw new Error(
          `Provider returned successful response with no choices (attempt ${attempt}/${maxAttempts}).`
        );
      }

      const choice = completion.choices[0];
      if (!choice?.message) {
        throw new Error(
          `Provider returned a choice without a message (attempt ${attempt}/${maxAttempts}).`
        );
      }

      return {
        ...choice.message,
        finish_reason: choice.finish_reason,
      };
    } catch (err: any) {
      const statusMatch = err.message?.match(/status (\d+)/);
      if (statusMatch) {
        const status = Number(statusMatch[1]);
        const shouldRetry = [408, 429, 500, 502, 503, 504].includes(status);
        if (!shouldRetry || attempt >= maxAttempts) {
          throw err;
        }
        lastError = err;
        continue;
      }

      if (
        err.message?.includes("not valid JSON") ||
        err.message?.includes("no choices") ||
        err.message?.includes("choice without a message") ||
        err.message?.startsWith("Provider returned error")
      ) {
        throw err;
      }

      const formattedErr = new Error(
        err.message?.includes("attempt")
          ? err.message
          : `AI request failed (${err.message || "Network error"}, attempt ${attempt}/${maxAttempts})`
      );
      lastError = formattedErr;
      if (attempt < maxAttempts) {
        continue;
      }
      throw formattedErr;
    }
  }

  throw lastError || new Error(`AI request failed (attempt ${maxAttempts}/${maxAttempts}).`);
}

export async function completeChat(
  messages: ChatMessage[],
  options: ChatCompletionOptions,
  overrideConfig?: LlmConfig,
) {
  const message = await completeChatMessage(messages, options, overrideConfig);
  if (message?.finish_reason === "length" && !message.content) {
    throw new Error("Model exhausted its token budget before returning an answer.");
  }
  if (options.responseFormat) {
    const output = message?.content?.trim() || message?.reasoning_content?.trim();
    if (!output) {
      throw new Error("Model did not return structured output.");
    }
    return output;
  }
  return message?.content || message?.reasoning_content || "";
}
