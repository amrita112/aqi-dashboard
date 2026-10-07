/**
 * A chat-completions client that is not tied to any one vendor.
 *
 * Deliberately plain `fetch` rather than an SDK. Groq, Cerebras, OpenRouter
 * and Together all expose the same OpenAI-compatible `/chat/completions`
 * shape, so swapping providers is a base URL and a model name — and the app
 * gains no npm dependency at all for its AI feature.
 *
 * Default is Groq's free tier: 30 requests a minute, 200K tokens a day,
 * open-weight models on their own hardware, and no data retention by default.
 * The model has to support tool calling and follow OpenAI's tools/tool_calls
 * schema exactly, which is the constraint that narrows the catalogue. See
 * DEFAULT_MODEL below for which one, and why it is worth re-checking.
 *
 * WHY SWAPPABLE IS NOT OVER-ENGINEERING: free tiers disappear. GitHub Models
 * was a popular free option and was retired on 30 July 2026. Everything
 * provider-specific in this file is three environment variables.
 *
 * Config:
 *   AI_API_KEY    required at runtime (GROQ_API_KEY is accepted as an alias)
 *   AI_BASE_URL   default https://api.groq.com/openai/v1
 *   AI_MODEL      default openai/gpt-oss-120b
 */

export const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * GROQ RETIRES MODELS WITHOUT WARNING, so this is a name that has to be checked
 * rather than assumed. The previous default, llama-3.3-70b-versatile, started
 * returning 404 "does not exist or you do not have access to it" — the key was
 * fine, the model was simply gone from the catalogue.
 *
 * Verified against the live account on 2026-10-07: of the eleven models
 * offered, only three are general-purpose chat models — openai/gpt-oss-120b,
 * openai/gpt-oss-20b and qwen/qwen3.8-27b. All three were confirmed to emit
 * tool_calls correctly, which this route depends on entirely; the rest are
 * speech (whisper), prompt-safety classifiers, or too small in context.
 *
 * 120b over 20b because the answer quality matters more than latency here: one
 * or two sentences on a free quota, a few times per visitor.
 *
 * If this 404s again, list what the key can actually see:
 *   curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
 * and set AI_MODEL rather than editing this, so a deployment can be fixed
 * without a release.
 */
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

/** Answers are one or two sentences; anything longer is not being read. */
export const DEFAULT_MAX_TOKENS = 220;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  usage: { prompt: number; completion: number } | null;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function aiConfig() {
  const apiKey = process.env.AI_API_KEY ?? process.env.GROQ_API_KEY ?? "";
  return {
    apiKey,
    baseUrl: (process.env.AI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.AI_MODEL ?? DEFAULT_MODEL,
    configured: apiKey.length > 0,
  };
}

/**
 * One round trip. Tool orchestration lives in the caller, so this stays a thin
 * transport and is trivial to fake in tests.
 */
export async function chat(
  messages: ChatMessage[],
  opts: {
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ChatResponse> {
  const cfg = aiConfig();
  if (!cfg.configured) {
    throw new AiProviderError("No AI_API_KEY (or GROQ_API_KEY) configured", 500, false);
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Low but not zero: the numbers come from the database, so the model is
    // only choosing a tool and phrasing a sentence. Determinism matters more
    // than variety here.
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AiProviderError(
      `Could not reach the model provider: ${(err as Error).message}`,
      503,
      true,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 429 is the one that actually matters on a free tier: the daily token
    // budget is exhausted, so the app stops answering rather than costing
    // anything. Surfaced distinctly so the route can say so plainly.
    throw new AiProviderError(
      response.status === 429
        ? "The free model quota is exhausted for now"
        : `Model provider returned ${response.status}: ${text.slice(0, 200)}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  const json = (await response.json()) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = json.choices?.[0];
  if (!choice?.message) {
    throw new AiProviderError("Model returned no message", 502, true);
  }

  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? "stop",
    usage: json.usage
      ? {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
        }
      : null,
  };
}
