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
import { chat, aiConfig, AiProviderError, undouble, type ChatMessage } from "@/lib/ai/provider";
import { TOOL_DEFINITIONS, executeTool, namesMeasure, type AskContext } from "@/lib/ai/tools";
import { istToday, toIstClock, toIstHour } from "@/lib/api/time";
import { quotaMessage, ASK_DAILY_LIMIT, nextIstMidnight, type QuotaKind } from "@/lib/ai/quota";
import { APP_NAME } from "@/lib/brand";
import { bestChart, provenanceFrom } from "@/lib/ai/chart";

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
// Shared with the Ask screen, which shows how many are left before the first question.
const PER_IP_PER_DAY = ASK_DAILY_LIMIT;
/**
 * A global cap, because per-IP alone does not bound the shared quota — a
 * hundred visitors within their own limits would still drain the day's tokens
 * between them.
 */
const GLOBAL_PER_DAY = 400;

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * When to try again after the provider's per-minute limit: never sooner than
 * a full minute.
 *
 * WHY NOT THE PROVIDER'S OWN Retry-After. Groq's says when ONE more request
 * would fit — often a few seconds — but a question is up to four requests of
 * 2,000-3,400 tokens each against an 8,000-token-a-minute bucket. Waiting
 * what Groq said and asking again ran out halfway through the next question,
 * so the screen said "wait" again, and again: what Amrita kept hitting. And
 * when Groq sent no Retry-After, there was no countdown at all. A minute is
 * how long the bucket takes to refill completely.
 */
const PROVIDER_PAUSE_MS = 60_000;

function providerPauseEnds(retryAfterSeconds: number | null): number {
  return Date.now() + Math.max(PROVIDER_PAUSE_MS, (retryAfterSeconds ?? 0) * 1000);
}

function systemPrompt(): string {
  return [
    "You answer questions about air quality in seven Indian cities: Delhi NCR, Mumbai, Bengaluru, Hyderabad, Chennai, Kolkata and Pune.",
    // THE MODEL HAS NO CLOCK. It knows nothing about when "now" is beyond what
    // this sentence tells it, and it never sees the visitor's device time --
    // this is computed on the server from UTC plus a fixed +5:30, so it is
    // correct for India regardless of where the server runs or where the
    // visitor is. Previously only the DATE was given, which left "is it bad
    // right now" and "should I go out this evening" to be answered without the
    // model knowing whether it was breakfast or midnight.
    `Right now in India it is ${toIstClock(new Date())} on ${istToday()} (Indian Standard Time, UTC+5:30). All times you mention are IST.`,
    `The current hour in IST is ${toIstHour(new Date())} on a 24-hour clock. "This evening" means roughly 18:00-21:00 today; "later today" means the hours after the current one.`,
    "",
    "Rules, in order of importance:",
    "1. Every number you state must come from a tool result. Never estimate, interpolate or recall a figure. If the tools did not return it, say you do not have it.",
    "1b. The same goes for FACTS, not just numbers. Do not state anything you were not given — not a date, not an organisation, not a name, not a claim about who runs something. If you are not sure, say you do not know. A confident wrong sentence is worse here than an admission, because everything else this app says is checkable.",
    "2. If a forecast day has mode 'seasonal_normal', it is NOT a prediction — it is the seasonal average, used because no recent reading was available. Say so in plain words. Never call it a forecast.",
    "3. Readings are typically 17-24 hours behind. If a tool reports data_age_hours over 24, mention the age rather than implying it is live.",
    "4. For 'now', 'today', 'this evening' or 'later today', use rest_of_today — NOT best_hour, which is tomorrow. Answering a question about today with tomorrow's numbers is wrong even when the numbers are close. If rest_of_today reports that too little of the day is left, do not stop there: call current_aqi for the most recent measured reading, give it with its age, and offer tomorrow. 'What is it now?' must never be answered with 'the day is nearly over'.",
    "5. If a tool returns an error field, explain it plainly. Do not retry with a made-up location.",
    "6. AQI here is India's CPCB scale, 0-500. It is driven by PM10 more often than PM2.5, which surprises people.",
    "7. Band names come from the tool's `band`, `cleanest_band` or `dirtiest_band` field. Never derive one from the number yourself. Use ONLY the CPCB band names, and only when a tool gave you one: Good, Satisfactory, Moderate, Poor, Very Poor, Severe. Never use US categories like 'unhealthy', 'unhealthy for sensitive groups' or 'hazardous' — they are a different scale and do not match what the rest of the app shows for the same number.",
    "",
    "8. ALWAYS NAME THE DATE. When a tool gives you a `date_label` such as 'tomorrow (10 Oct)', copy it EXACTLY — do not recompute which day it is. Getting the number right and the date wrong is worse than refusing.",
    "9. The forecast reaches 7 days ahead. For anything beyond that, say plainly that it is outside the forecast window rather than answering from the seasonal average as though it were a forecast.",
    "10. For comparing two places OVER TIME — a trend, a chart, day by day, or across the forecast — point the person at the Trends tab, which plots two places on one axis and lets them change either. Answer the single-number comparison if there is one, then add the pointer in a short clause. Do not try to narrate a two-place series.",
    // QUESTIONS ABOUT THE APP ITSELF. No tool answers these, so the model
    // answered from its own training and invented: "launched in early 2023",
    // "developed by the team at AirNow India". Both false, both delivered in
    // the same confident voice as a real reading, and the second attaches a
    // stranger's name to someone else's work. Rule 1 only ever constrained
    // NUMBERS, which these are not.
    //
    // A refusal would be safe and useless — people reasonably ask what they
    // are using. So the true answers are supplied here and the model is told
    // to use these and nothing else.
    "12. ABOUT THIS APP, when someone asks what it is, who made it, when it started, where its data comes from, or what AI it uses: answer ONLY from these facts, and if the question is not covered by them, say plainly that you do not know rather than guessing.",
    `   - It is called ${APP_NAME}. It forecasts air quality for seven Indian cities: Delhi NCR, Mumbai, Bengaluru, Hyderabad, Chennai, Kolkata and Pune.`,
    "   - It is an independent project, free to use, with no accounts and no advertising. It is NOT run by any government body, and it is not connected to AirNow, AirNow India, CPCB, OpenAQ or XKDR, which are sources or other services, not its authors.",
    "   - Its readings come from India's Central Pollution Control Board monitoring network, reaching it through OpenAQ and the XKDR Forum's archive.",
    "   - You are a model served by Groq. Do not name a different provider or model.",
    "   - You do NOT know who built it, when it launched, how many people use it, or anything about its future plans. Say so. Point people at the Settings tab, which has the data sources and the privacy page.",
    "11. ANY place in a covered city can be reported on, whether or not it has a station of its own. The tools average the three nearest stations to wherever the person names, which is what every screen in this app does — so answer for the neighbourhood they asked about, using its name. Never tell someone their neighbourhood 'has no monitoring station' and never substitute a different place's name for theirs. The one exception is rank_places, which lists stations and can only name stations. If a tool returns unknown_location, the place is outside the covered cities — say that instead.",
    "A tool result may contain an `hourly` array of 24 values. Like `series`, it is there to draw the chart beside your answer. Never list it; quote at most the one or two hours that answer the question.",
    "A tool result may contain a `series` field. It exists only to draw the chart shown beside your answer. NEVER recite it — summarise with the mean, min and max that accompany it. Listing dates and values is exactly what the chart is for.",
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
  let place: Record<string, unknown> = {};
  try {
    const body = (await request.json()) as { question?: unknown; place?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
    if (body.place && typeof body.place === "object") {
      place = body.place as Record<string, unknown>;
    }
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
  // Daily allowances reset at IST midnight, the same moment the screen's own
  // count does, rather than 24 hours after the first question.
  const midnight = nextIstMidnight();
  const perDay = rateLimit(`ask:day:${caller}`, PER_IP_PER_DAY, DAY, midnight);
  if (!perDay.allowed) return outOfQuestions("per_day", perDay.resetAt);
  const global = rateLimit("ask:day:global", GLOBAL_PER_DAY, DAY, midnight);
  if (!global.allowed) return outOfQuestions("shared_day", global.resetAt);

  // Where the person is and what they read, sent as fields rather than prose.
  // Buried in the question text it was advice the model could ignore; as a tool
  // argument it is simply what the tools use.
  const ctx: AskContext = {
    latitude: typeof place.latitude === "number" ? place.latitude : undefined,
    longitude: typeof place.longitude === "number" ? place.longitude : undefined,
    label: typeof place.label === "string" ? place.label.slice(0, 80) : undefined,
    city: typeof place.city === "string" ? place.city.slice(0, 60) : undefined,
    measurement: place.measurement === "pm25" ? "pm25" : "aqi",
    // "What will the AQI be tomorrow" from someone reading PM2.5 is asking
    // for AQI, so naming a measure lets the model's choice stand. Anything
    // else gets the setting. Tested on the question alone, not the "(I am in
    // ...)" note the screen appends, which names neither.
    measurementNamed: namesMeasure(question),
  };

  const supabase = createClient();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: question },
  ];

  const toolsUsed: { name: string; args: unknown }[] = [];
  // Kept so the answer can be shown with a chart. Built from the SAME result
  // the model was given, in code, so the picture cannot disagree with the
  // sentence — neither of them invented anything.
  const toolResults: { name: string; result: unknown }[] = [];
  let tokens = { prompt: 0, completion: 0 };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // ON THE LAST ROUND, ASK IN WORDS RATHER THAN WITHDRAWING THE TOOLS.
      //
      // Dropping `tools` makes Groq default tool_choice to "none", and
      // gpt-oss-120b calls a tool anyway — which the provider then rejects
      // outright: 400 "Tool choice is none, but model called a tool". So any
      // question needing more than MAX_TOOL_ROUNDS rounds did not degrade to a
      // worse answer, it died. That is the error Amrita hit with "where in
      // mumbai is best for a run", and the cause of several blank answers.
      //
      // Keeping the tools present means the request is always valid; the
      // instruction below is what actually stops it looking things up, and if
      // it calls one anyway the result is discarded a few lines down rather
      // than failing the request.
      const atCeiling = round === MAX_TOOL_ROUNDS;
      if (atCeiling) {
        messages.push({
          role: "system",
          content:
            "You now have everything you are going to get. Answer the question in words from the tool results above. Do not call any more tools. If the results do not contain what was asked for, say plainly what you could not find.",
        });
      }
      const response = await chat(messages, { tools: TOOL_DEFINITIONS });
      if (response.usage) {
        tokens = {
          prompt: tokens.prompt + response.usage.prompt,
          completion: tokens.completion + response.usage.completion,
        };
      }

      // At the ceiling, ignore any tool calls: the loop is over, and the
      // content is what matters. Treating them as calls would spend another
      // round that does not exist.
      const calls = atCeiling ? [] : (response.message.tool_calls ?? []);
      if (!calls.length) {
        const answer = undouble(response.message.content ?? "");
        if (!answer) {
          // Empty content with no tool calls means the model had nothing to
          // say — usually because every tool it tried returned an error. Say
          // which tools ran, so this is diagnosable from the response instead
          // of from the server log.
          // NOT "try asking about one place and one day", which was both
          // untrue and insulting: the tools compare places, forecast seven
          // days and carry seasonal normals into February. An empty answer is
          // our failure, not a malformed question.
          const tried = toolsUsed.map((t) => t.name).join(", ") || "none";
          // THE QUESTION ITSELF IS NOT LOGGED. It used to be, which quietly
          // contradicted the rule written at the top of lib/analytics.ts: an
          // app that argues air quality data should be public and personal
          // data should not cannot keep a log of what its users are worried
          // about, even a short-lived one. "Is the air bad where my daughter
          // goes to school" is the sentence this is about.
          //
          // The length and the tools are what made this diagnosable anyway —
          // the empty answers we chased were long questions and tool errors,
          // neither of which needs the words.
          console.error(
            `Empty answer. Question length: ${question.length}. Tools: ${tried}. Rounds: ${round}.`,
          );
          return fail(
            "Something went wrong producing that answer. Please ask again — it may work the second time.",
            502,
          );
        }
        return ok(
          {
            question,
            answer,
            tools_used: toolsUsed,
            chart: bestChart(toolResults),
            provenance: provenanceFrom(toolResults),
          },
          {
            model: cfg.model,
            rounds: round,
            tokens,
            // Kept for logs and for the limiter's own reckoning. The SCREEN
            // counts on the client instead: this figure comes from one
            // serverless instance's memory and jumps when another answers.
            remaining_today: perDay.remaining,
            daily_limit: PER_IP_PER_DAY,
          },
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
        const result = await executeTool(supabase, call.function.name, args, ctx);
        toolResults.push({ name: call.function.name, result });
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
      if (err.status === 429) {
        // A minute-bucket 429 recovers while the person reads the message, so
        // it gets the short-break wording and a countdown when the provider
        // sent a Retry-After. A day-bucket one does not.
        const minute = err.window === "minute";
        return outOfQuestions(
          minute ? "provider_minute" : "provider",
          minute ? providerPauseEnds(err.retryAfterSeconds) : null,
        );
      }
      return fail(err.message, 502);
    }
    return fail(`Unexpected failure answering the question: ${(err as Error).message}`, 500);
  }
}
