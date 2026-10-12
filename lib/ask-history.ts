/**
 * The last few questions and answers, kept in the browser.
 *
 * TWO PROBLEMS, ONE MECHANISM.
 *
 * The rate limit is three questions a minute, which is tight for someone
 * exploring — and several of those questions are ones they already asked.
 * Showing recent questions as chips, with their answers cached, means
 * re-reading an answer costs nothing and does not touch the quota at all.
 *
 * It also makes the screen survive a remount. Amrita saw a question and answer
 * vanish after a period of inactivity; state held only in React is lost to
 * anything that remounts the component, and restoring from here makes that
 * invisible rather than merely rarer.
 *
 * SAME STORAGE CAVEAT AS PREFS: this is per-browser, it is lost when site data
 * is cleared, and it never reaches a server. Nothing here is important enough
 * to deserve an account.
 */

import type { AnswerChart, Provenance } from "@/lib/ai/chart";

export interface AskEntry {
  /** The question as the person typed it, without the location context. */
  question: string;
  answer: string;
  tools: string[];
  chart: AnswerChart | null;
  provenance: Provenance | null;
  /** Unix ms. Shown as "2 min ago" and used to drop stale entries. */
  asked_at: number;
}

export const ASK_HISTORY_KEY = "aqi.ask.v1";

/** Enough to be useful on a phone without becoming a transcript. */
export const MAX_HISTORY = 6;

/**
 * Answers go stale because the underlying data does. A day is well past the
 * point where "today" in a cached answer still means today.
 */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function loadHistory(): AskEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ASK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AskEntry[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed
      .filter((e) => e && typeof e.question === "string" && e.asked_at > cutoff)
      .slice(0, MAX_HISTORY);
  } catch {
    // Private browsing, blocked storage, or a shape from an older version.
    return [];
  }
}

/** Newest first, de-duplicated by question, capped. */
export function addToHistory(entry: AskEntry, existing: AskEntry[]): AskEntry[] {
  const key = entry.question.trim().toLowerCase();
  const rest = existing.filter((e) => e.question.trim().toLowerCase() !== key);
  const next = [entry, ...rest].slice(0, MAX_HISTORY);
  try {
    window.localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* Storage full or blocked: the history is a convenience, not the answer. */
  }
  return next;
}

export function clearHistory(): void {
  try {
    window.localStorage.removeItem(ASK_HISTORY_KEY);
  } catch {
    /* Nothing to do. */
  }
}

/**
 * What to offer asking next, chosen from the tool that just answered.
 *
 * DERIVED, NOT GENERATED. Asking the model for a follow-up would cost another
 * round trip against a three-per-minute limit, and it could propose a question
 * the tools cannot answer. Keyed off the tool, every suggestion is one we know
 * we can serve.
 *
 * EVERY ONE IS SELF-CONTAINED, and this is not a style preference. Each
 * question is answered on its own with no memory of the last — so "How does
 * that compare with last week?" was a promise the app cannot keep, and tapping
 * it produced an answer about nothing in particular. The words "that", "then"
 * and "it" cannot appear as the subject; the place and the day are named every
 * time. There is a test.
 */
export function suggestNext(tools: string[], place: string): string | null {
  const last = tools[tools.length - 1];
  switch (last) {
    case "rest_of_today":
      return `How will the air quality be tomorrow in ${place}?`;
    case "best_hour":
      return `What do the next few days look like in ${place}?`;
    case "forecast":
      return `What's the best time of the day today in ${place}?`;
    case "rank_places":
      return `What is the forecast for ${place} this week?`;
    case "history":
      return `What is the forecast for ${place} tomorrow?`;
    case "compare":
      return `What is the forecast for ${place} tomorrow?`;
    case "current_aqi":
      return `What's the forecast for the next few hours in ${place}?`;
    default:
      return null;
  }
}

/** "just now", "4 min ago", "2 h ago" — short enough for a chip. */
export function shortAge(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}
