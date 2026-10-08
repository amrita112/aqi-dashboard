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
/**
 * THIS WAS 220 AND IT WAS STARVING THE ANSWER.
 *
 * gpt-oss-120b is a reasoning model: it emits a `reasoning` field that we never
 * read, and those tokens count against max_tokens before a single character of
 * `content` is produced. Measured on one of Amrita's failing questions, the
 * model spent 746 characters of reasoning against a 220-token budget — it fit
 * by luck, and with our system prompt and a page of tool results it did not.
 * The result was content: "" with no tool calls, which the route reported as
 * "no answer could be produced".
 *
 * So the empty answers were not the model declining to answer. It never got as
 * far as answering.
 *
 * 700 is comfortable headroom for reasoning plus two sentences. The answer
 * itself is still short; nothing here changes how much the model SAYS.
 */
export const DEFAULT_MAX_TOKENS = 700;

/**
 * Reasoning costs tokens against both the budget above and the 8,000-per-minute
 * account limit. At "low" the same question used 113 completion tokens against
 * 322 at "medium", with an answer of the same quality — this is two sentences
 * chosen from six tools, not a problem that rewards deliberation.
 *
 * Ignored by providers and models that do not support it.
 */
export const REASONING_EFFORT = "low";

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
    /** Set internally when retrying a garbled tool call; not for callers. */
    isRetry?: boolean;
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
    reasoning_effort: REASONING_EFFORT,
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

    // THE MODEL SOMETIMES EMITS MALFORMED TOOL ARGUMENTS and Groq rejects the
    // whole request with 400 tool_use_failed — "Failed to parse tool call
    // arguments as JSON". It is a generation slip, not a problem with the
    // question, and the same question usually succeeds on a second attempt.
    // Retried once rather than shown to the person, who saw a wall of provider
    // JSON for asking "what about the day after?".
    const toolSlip = response.status === 400 && text.includes("tool_use_failed");
    if (toolSlip && !opts.isRetry) {
      return chat(messages, { ...opts, isRetry: true });
    }

    // 429 is the one that actually matters on a free tier: the daily token
    // budget is exhausted, so the app stops answering rather than costing
    // anything. Surfaced distinctly so the route can say so plainly.
    //
    // Nothing else leaks the provider's raw body to a user. It is diagnostic
    // for us and noise to them, so the message is plain and the detail goes to
    // the server log.
    if (response.status !== 429) {
      console.error(`AI provider ${response.status}: ${text.slice(0, 500)}`);
    }
    throw new AiProviderError(
      response.status === 429
        ? "The free model quota is exhausted for now"
        : toolSlip
          ? "The model garbled its request twice in a row. Please ask again."
          : "The model provider could not answer that just now.",
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

/**
 * Strip an answer that the model emitted twice.
 *
 * gpt-oss-120b occasionally returns its sentence doubled, with no separator:
 * "...prefer running there.Powai (MPCB) is the cleanest...". It is the model's
 * quirk, not a parsing bug -- `content` arrives doubled and `reasoning` is a
 * separate field we never read.
 *
 * Only an EXACT doubling is removed. Anything cleverer risks truncating a real
 * answer that happens to repeat a phrase, which is a worse failure than showing
 * a sentence twice.
 */
export function undouble(answer: string): string {
  const t = answer.trim();
  if (t.length < 2) return t;
  const half = Math.floor(t.length / 2);
  if (t.length % 2 === 0 && t.slice(0, half) === t.slice(half)) {
    return t.slice(0, half).trim();
  }
  // The same, allowing one space or newline between the two copies.
  for (const sep of [" ", "\n", "\n\n"]) {
    const n = (t.length - sep.length) / 2;
    if (Number.isInteger(n) && n > 0) {
      const a = t.slice(0, n);
      if (a + sep + a === t) return a.trim();
    }
  }
  return t;
}
