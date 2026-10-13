/**
 * What we measure, and deliberately what we do not.
 *
 * Vercel's page views already answer "which tab do people use", because every
 * tab is a real route. This file is for the handful of things a page view
 * cannot see, each one chosen because it would change a decision:
 *
 *   installed        did the install hint work, or are people on a bookmark?
 *   question_asked   is the AI box used at all, and which TOOL answered?
 *   question_failed  how often do we decline, and for what reason?
 *
 * NOTHING HERE RECORDS WHAT ANYONE ASKED. Not the question, not the place, not
 * the answer. Only the name of the tool that ran and, when something failed,
 * the reason. An app whose argument is that it does not overclaim should not
 * quietly accumulate a log of what its users are worried about — and a question
 * like "is the air bad where my daughter goes to school" is exactly the kind of
 * thing that would end up in such a log.
 *
 * Vercel Analytics is cookieless and stores no identifier, so none of this is
 * tied to a person across visits.
 *
 * TWO SINKS, AND ONLY ONE OF THEM WORKS TODAY. Vercel puts CUSTOM EVENTS
 * behind its Pro plan, and `track()` does not fail when they are unavailable —
 * it silently drops everything. So for months this file looked healthy while
 * recording nothing at all. Every call now ALSO posts to /api/event, which
 * writes a row to Supabase (migration 19), and that is the sink to trust.
 *
 * The Vercel call is kept rather than removed because it costs nothing, breaks
 * nothing, and starts working by itself the day the plan changes. It is not
 * evidence of anything in the meantime.
 */

import { track } from "@vercel/analytics";

/**
 * Post a count to our own store, and never let it matter if it fails.
 *
 * keepalive, because the most important event in this file — `installed` —
 * often fires as the page is being replaced by the newly installed app, and an
 * ordinary fetch is cancelled when that happens.
 */
function record(name: string, detail: string | null): void {
  try {
    void fetch("/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, detail }),
      keepalive: true,
    }).catch(() => {
      // Offline, blocked, or the endpoint is down. A missing count is not
      // worth a console error on someone else's phone.
    });
  } catch {
    /* see above */
  }
}

/** Tool names from lib/ai/tools.ts, plus the two non-tool outcomes. */
export type AskOutcome =
  | "answered"
  | "no_tool"
  | "declined"
  | "quota"
  | "error";

/**
 * One AI question, by the tool that answered it.
 *
 * `tool` is the LAST tool called, which is the one that produced the answer.
 * Multi-tool answers are rare and the last call is what the sentence is about.
 */
export function trackQuestion(outcome: AskOutcome, tool: string | null): void {
  try {
    track("question", {
      outcome,
      // "none" rather than null so the Vercel dashboard groups it as a value
      // rather than dropping the property.
      tool: tool ?? "none",
    });
  } catch {
    // Analytics must never break the thing it is measuring.
  }
  // The tool is the more useful of the two for "which tools earn their keep",
  // and an answer with no tool behind it is itself worth counting.
  record("question", tool ?? (outcome === "answered" ? "none" : outcome));
}

/**
 * Why an answer did not happen. A small fixed set, because free-text reasons
 * would be unsearchable and could carry fragments of the question.
 */
export type FailureReason =
  | "out_of_questions"
  | "unknown_location"
  | "no_data"
  | "provider_error"
  | "network";

export function trackFailure(reason: FailureReason): void {
  try {
    track("question_failed", { reason });
  } catch {
    /* see above */
  }
  record("question_failed", reason);
}

/** The PWA was installed to a home screen. Fires once, when it happens. */
export function trackInstalled(source: "prompt" | "browser"): void {
  try {
    track("installed", { source });
  } catch {
    /* see above */
  }
  record("installed", source);
}
