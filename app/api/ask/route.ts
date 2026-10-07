/**
 * POST /api/ask   { "question": "is Delhi worse than Mumbai this week?" }
 *
 * The AI box. The model picks from five fixed tools and writes one or two
 * sentences; every number it states comes out of the database.
 *
 * Runs on Groq's free tier by default, so the thing being protected is not a
 * bill but a QUOTA — 200K tokens a day, shared by everyone using the app. When
 * it runs out the app stops answering. That makes the rate limit a
 * availability feature, and it makes the tool-call ceiling matter: an
 * unbounded loop would eat the day's budget on one question.
 */

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { fail, ok, badRequest, rateLimit, callerKey } from "@/lib/api/respond";
import { chat, aiConfig, AiProviderError, type ChatMessage } from "@/lib/ai/provider";
import { TOOL_DEFINITIONS, executeTool } from "@/lib/ai/tools";
import { istToday } from "@/lib/api/time";
import { quotaMessage, type QuotaKind } from "@/lib/ai/quota";

export const dynamic = "force-dynamic";

/** Two rounds is enough for "compare A and B"; more is a loop, not an answer. */
const MAX_TOOL_ROUNDS = 3;
const MAX_QUESTION_CHARS = 500;

/**
 * THREE, NOT FIVE, BECAUSE OF THE PROVIDER'S TOKEN BUCKET. Groq allows 8,000
 * tokens per MINUTE on this model, and a question costs 2,200-3,400 (the system
 * prompt and tool results dominate; the answer is ~100). Five in a minute is
 * 11,000-17,000 and overruns it — measured, not estimated: asking five in a row
 * returned Groq's own 429 before our limit ever fired.
 *
 * Losing that race is worse than it sounds. The visitor gets the "provider"
 * message, which cannot carry a countdown because we do not know when Groq's
 * bucket refills, and we have spent a failed API call to find out.
 *
 * Three can still overrun when several people ask at once — the bucket is
 * shared across everyone and no per-IP limit can bound that — which is why the
 * provider path stays handled rather than assumed away.
 */
const PER_IP_PER_MINUTE = 3;
const PER_IP_PER_DAY = 40;
/**
 * A global cap, because per-IP alone does not bound the shared quota — a
 * hundred visitors within their own limits would still drain the day's tokens
 * between them.
 */
const GLOBAL_PER_DAY = 400;

const MINUTE = 60_000;
const DAY = 86_400_000;

function systemPrompt(): string {
  return [
    "You answer questions about air quality in seven Indian cities: Delhi NCR, Mumbai, Bengaluru, Hyderabad, Chennai, Kolkata and Pune.",
    `Today is ${istToday()} in India. All times are Indian Standard Time.`,
    "",
    "Rules, in order of importance:",
    "1. Every number you state must come from a tool result. Never estimate, interpolate or recall a figure. If the tools did not return it, say you do not have it.",
    "2. If a forecast day has mode 'seasonal_normal', it is NOT a prediction — it is the seasonal average, used because no recent reading was available. Say so in plain words. Never call it a forecast.",
    "3. Readings are typically 17-24 hours behind. If a tool reports data_age_hours over 24, mention the age rather than implying it is live.",
    "4. For 'now', 'today', 'this evening' or 'later today', use rest_of_today — NOT best_hour, which is tomorrow, and not current_aqi, which is the last measured reading and is often days old. Answering a question about today with tomorrow's numbers is wrong even when the numbers are close.",
    "5. If a tool returns an error field, explain it plainly. Do not retry with a made-up location.",
    "6. AQI here is India's CPCB scale, 0-500. It is driven by PM10 more often than PM2.5, which surprises people.",
    "7. Use ONLY the CPCB band names, and only when a tool gave you one: Good, Satisfactory, Moderate, Poor, Very Poor, Severe. Never use US categories like 'unhealthy', 'unhealthy for sensitive groups' or 'hazardous' — they are a different scale and do not match what the rest of the app shows for the same number.",
    "",
    "Answer in at most two short sentences. No preamble, no bullet points, no markdown. Be specific and plain.",
  ].join("\n");
}

export async function POST(request: Request) {
  const cfg = aiConfig();
  if (!cfg.configured) {
    return fail(
      "The question box is not configured on this deployment (no AI_API_KEY).",
      503,
    );
  }

  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return badRequest("Body must be JSON: { question: string }");
  }
  if (!question) return badRequest("question is required");
  if (question.length > MAX_QUESTION_CHARS) {
    return badRequest(`question must be at most ${MAX_QUESTION_CHARS} characters`);
  }

  // All four exhaustion paths answer in the same voice and carry a machine
  // readable `quota` object, so the screen can explain what happened rather
  // than showing a bare "429 Too Many Requests".
  const outOfQuestions = (kind: QuotaKind, resetAt: number | null) => {
    const q = quotaMessage(kind, resetAt);
    return NextResponse.json(
      { error: { message: q.message, code: "out_of_questions", quota: q } },
      {
        status: 429,
        ...(resetAt
          ? { headers: { "Retry-After": String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) } }
          : {}),
      },
    );
  };

  const caller = callerKey(request);
  const perMinute = rateLimit(`ask:min:${caller}`, PER_IP_PER_MINUTE, MINUTE);
  if (!perMinute.allowed) return outOfQuestions("per_minute", perMinute.resetAt);
  const perDay = rateLimit(`ask:day:${caller}`, PER_IP_PER_DAY, DAY);
  if (!perDay.allowed) return outOfQuestions("per_day", perDay.resetAt);
  const global = rateLimit("ask:day:global", GLOBAL_PER_DAY, DAY);
  if (!global.allowed) return outOfQuestions("shared_day", global.resetAt);

  const supabase = createClient();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: question },
  ];

  const toolsUsed: { name: string; args: unknown }[] = [];
  let tokens = { prompt: 0, completion: 0 };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // On the last permitted round, drop the tools so the model is forced to
      // answer from what it already has rather than asking for more.
      const atCeiling = round === MAX_TOOL_ROUNDS;
      const response = await chat(messages, {
        tools: atCeiling ? undefined : TOOL_DEFINITIONS,
      });
      if (response.usage) {
        tokens = {
          prompt: tokens.prompt + response.usage.prompt,
          completion: tokens.completion + response.usage.completion,
        };
      }

      const calls = response.message.tool_calls ?? [];
      if (!calls.length) {
        const answer = (response.message.content ?? "").trim();
        if (!answer) return fail("The model returned an empty answer", 502);
        return ok(
          { question, answer, tools_used: toolsUsed },
          { model: cfg.model, rounds: round, tokens, remaining_today: perDay.remaining },
        );
      }

      messages.push(response.message);
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // A malformed argument string is the model's mistake to recover
          // from, not a reason to fail the request.
          args = {};
        }
        toolsUsed.push({ name: call.function.name, args });
        const result = await executeTool(supabase, call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
    }

    return fail("Could not settle on an answer within the tool budget", 504);
  } catch (err) {
    if (err instanceof AiProviderError) {
      // Groq's own limit, which we do not control and cannot predict the reset
      // of — same explanation, no countdown.
      if (err.status === 429) return outOfQuestions("provider", null);
      return fail(err.message, 502);
    }
    return fail(`Unexpected failure answering the question: ${(err as Error).message}`, 500);
  }
}
