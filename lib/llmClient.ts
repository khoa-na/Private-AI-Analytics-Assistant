export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionOptions = {
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: { message?: string };
};

export async function completeChat(
  messages: ChatMessage[],
  options: ChatCompletionOptions,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  if (!apiKey || !model) {
    throw new Error("Set OPENAI_API_KEY and OPENAI_MODEL in .env.local.");
  }

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
      ...(options.responseFormat
        ? { response_format: options.responseFormat }
        : {}),
      ...(process.env.OPENAI_BASE_URL
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
      messages,
    }),
  });

  const completion = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(completion.error?.message ?? "AI request failed.");
  }

  const message = completion.choices?.[0]?.message;
  return message?.content || message?.reasoning_content || "";
}
