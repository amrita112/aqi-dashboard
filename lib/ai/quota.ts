/**
 * What the app says when the AI box runs out of questions.
 *
 * Three different things exhaust in different ways and the user cannot tell
 * them apart, so they share one voice and one explanation:
 *
 *   per-minute, per-IP   asking faster than the provider's token bucket refills
 *   per-day, per-IP      one visitor's share of the shared budget
 *   daily global         everyone's share of the shared budget
 *   provider 429         Groq's own free-tier limit, which we do not control —
 *                        split by whether its own message says the empty
 *                        bucket refills in a minute or tomorrow
 *
 * The honest framing is that this is a free app running on a free model quota
 * shared by everyone using it — not a fault, not a paywall tease, and not a
 * suggestion that the rest of the app has stopped working. It has not: the
 * forecast, map, trends and current readings never touch the AI provider.
 *
 * `kind` is for the UI, which shows a countdown for the ones that recover in
 * minutes and does not for the ones that recover tomorrow.
 */

export type QuotaKind =
  | "per_minute"
  | "per_day"
  | "shared_day"
  | "provider"
  | "provider_minute";

export interface QuotaMessage {
  kind: QuotaKind;
  message: string;
  /** Unix ms when asking again is worth trying, when that is knowable. */
  resetAt: number | null;
  /** The sentence about paid access, kept separate so the UI can style it. */
  future: string;
}

/**
 * Said once, in one place. Repeating "this is the free version" in four
 * slightly different wordings is how a product starts sounding apologetic.
 */
const FUTURE =
  "This is the free version of the app, which includes a limited number of AI questions shared by everyone using it. A future version will let you pay for unlimited questions.";

const REST_STILL_WORKS =
  "Everything else still works — the forecast, map, trends and current readings do not use AI.";

export function quotaMessage(kind: QuotaKind, resetAt: number | null = null): QuotaMessage {
  const lead: Record<QuotaKind, string> = {
    per_minute: "You asked a few questions in quick succession. The AI agent needs a short break.",
    per_day: "You have used your questions for today.",
    shared_day: "Today's shared pool of AI questions is used up.",
    provider: "The AI service this app uses has hit its free daily limit.",
    // A PROVIDER 429 IS USUALLY THE PER-MINUTE BUCKET, not the daily one, and
    // calling every one of them "daily" put "hit its free daily limit" on the
    // screen next to "38 questions left today". Same voice, right timescale.
    provider_minute:
      "That was a few questions in quick succession for the AI service. It needs a short break.",
  };
  return {
    kind,
    message: `${lead[kind]} ${FUTURE} ${REST_STILL_WORKS}`,
    resetAt,
    future: FUTURE,
  };
}

/**
 * Questions per device per day. Here rather than in the route so the Ask
 * screen can show "40 questions left" as soon as it opens: it used to learn the
 * number only from a successful answer, so the line vanished every time the
 * tab was reopened.
 */
export const ASK_DAILY_LIMIT = 40;

/** The limits that recover in a minute or so, and so deserve a countdown. */
export function isShortPause(kind: QuotaKind): boolean {
  return kind === "per_minute" || kind === "provider_minute";
}

/**
 * The next midnight in India, as Unix ms.
 *
 * The daily limits reset HERE, not 24 hours after someone's first question.
 * A rolling window meant a person who started at 11pm was still refused the
 * next evening, while the screen's own count (which resets at IST midnight,
 * see lib/ask-count) said they had questions left.
 */
export function nextIstMidnight(now: number = Date.now()): number {
  const IST = 330 * 60_000;
  const DAY = 86_400_000;
  return Math.floor((now + IST) / DAY) * DAY + DAY - IST;
}
