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

type ChatCompletionOptions = {
  maxTokens: number;
  temperature: number;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  responseFormat?: Record<string, unknown>;
  tools?: ChatTool[];
  toolChoice?: string | Record<string, unknown>;
};

export function stageReasoningEffort(name: string, retry = false) {
  const value = process.env[name] ?? process.env.OPENAI_REASONING_EFFORT;
  const effort = ["low", "medium", "high"].includes(value ?? "")
    ? value as ChatCompletionOptions["reasoningEffort"]
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

export function tokenBudget(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function completeChatMessage(
  messages: ChatMessage[],
  options: ChatCompletionOptions,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = options.model ?? process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  if (!apiKey || !model) {
    throw new Error("Set OPENAI_API_KEY and OPENAI_MODEL in .env.local.");
  }

  const deepSeekThinking = /deepseek/i.test(model) &&
    ["enabled", "disabled"].includes(process.env.DEEPSEEK_THINKING_MODE ?? "")
    ? process.env.DEEPSEEK_THINKING_MODE as "enabled" | "disabled"
    : undefined;
  const reasoningEffort =
    deepSeekThinking === "disabled"
      ? undefined
      : options.reasoningEffort ??
        (process.env.OPENAI_REASONING_EFFORT as ChatCompletionOptions["reasoningEffort"]) ??
        (/deepseek/i.test(model) ? "low" : undefined);
  const localThinking =
    process.env.OPENAI_CHAT_TEMPLATE_THINKING ??
    (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(baseURL) ? "false" : undefined);

  const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(deepSeekThinking ? { thinking: { type: deepSeekThinking } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(options.responseFormat
        ? { response_format: options.responseFormat }
        : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(localThinking !== undefined
        ? { chat_template_kwargs: { enable_thinking: localThinking === "true" } }
        : {}),
      messages,
    }),
  });

  const completion = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(completion.error?.message ?? "AI request failed.");
  }

  const choice = completion.choices?.[0];
  return choice?.message
    ? { ...choice.message, finish_reason: choice.finish_reason }
    : undefined;
}

export async function completeChat(
  messages: ChatMessage[],
  options: ChatCompletionOptions,
) {
  const message = await completeChatMessage(messages, options);
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
