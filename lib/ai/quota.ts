/**
 * What the app says when the AI box runs out of questions.
 *
 * Three different things exhaust in different ways and the user cannot tell
 * them apart, so they share one voice and one explanation:
 *
 *   per-minute, per-IP   asking faster than the provider's token bucket refills
 *   per-day, per-IP      one visitor's share of the shared budget
 *   daily global         everyone's share of the shared budget
 *   provider 429         Groq's own free-tier limit, which we do not control
 *
 * The honest framing is that this is a free app running on a free model quota
 * shared by everyone using it — not a fault, not a paywall tease, and not a
 * suggestion that the rest of the app has stopped working. It has not: the
 * forecast, map, trends and current readings never touch the AI provider.
 *
 * `kind` is for the UI, which shows a countdown for the ones that recover in
 * minutes and does not for the ones that recover tomorrow.
 */

export type QuotaKind = "per_minute" | "per_day" | "shared_day" | "provider";

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
    per_minute: "You have asked a few questions in quick succession, so the question box needs a short break.",
    per_day: "You have used your questions for today.",
    shared_day: "Today's shared pool of AI questions is used up.",
    provider: "The AI service this app uses has hit its free daily limit.",
  };
  return {
    kind,
    message: `${lead[kind]} ${FUTURE} ${REST_STILL_WORKS}`,
    resetAt,
    future: FUTURE,
  };
}
