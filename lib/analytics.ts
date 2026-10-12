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
 */

import { track } from "@vercel/analytics";

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
}

/** The PWA was installed to a home screen. Fires once, when it happens. */
export function trackInstalled(source: "prompt" | "browser"): void {
  try {
    track("installed", { source });
  } catch {
    /* see above */
  }
}
