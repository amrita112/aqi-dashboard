/**
 * How many AI questions this device has asked today.
 *
 * WHY THE COUNT IS KEPT HERE RATHER THAN READ FROM THE SERVER. The server's
 * limiter is an in-memory counter inside one serverless instance, and Vercel
 * runs several that do not share it (the limitation is written down in
 * lib/api/respond.ts). So the "questions left" it reports depends on which
 * instance answered: the number on screen went from 37 up to 39 between two
 * questions, which makes the whole figure look invented.
 *
 * The server stays the enforcer — this changes nothing about what is allowed.
 * It only changes where the number SHOWN comes from, to one that cannot move
 * backwards: this browser's own tally. The cost is that two devices on one
 * connection each see their own count while sharing a budget, so the server
 * may refuse while the screen still shows some left. That is the honest
 * failure of the two, and the refusal explains itself when it happens.
 */

import { isShortPause, nextIstMidnight, type QuotaKind } from "@/lib/ai/quota";

const PREFIX = "aqi.ask.count.";

/** Today's date in India, so the tally resets at IST midnight like the quota. */
function istDay(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export function questionsAskedToday(): number {
  try {
    const n = Number(window.localStorage.getItem(PREFIX + istDay()));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Private window or blocked storage: no tally, so no count to show.
    return 0;
  }
}

/** Record one answered question, and return the new total. */
export function countQuestion(): number {
  const next = questionsAskedToday() + 1;
  try {
    const key = PREFIX + istDay();
    window.localStorage.setItem(key, String(next));
    // Yesterday's keys would otherwise accumulate one per day forever.
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== key) window.localStorage.removeItem(k);
    }
  } catch {
    /* nothing to do */
  }
  return next;
}

/**
 * "You have run out", remembered until it stops being true.
 *
 * It used to live only in the screen's memory, so leaving the Ask tab and
 * coming back — or closing the app — wiped it, and the screen went back to
 * offering questions the server would refuse. Now the refusal is kept on the
 * device until the moment it lifts: a minute or so for a short pause, IST
 * midnight for anything daily.
 */
const BLOCK_KEY = "aqi.ask.block";

export interface StoredQuota {
  kind: QuotaKind;
  message: string;
  resetAt: number | null;
  future: string;
}

interface StoredBlock {
  quota: StoredQuota;
  question: string;
  until: number;
}

/**
 * Remember a refusal, and return the quota with a definite reset time for a
 * short pause, so the screen always has a countdown to show (the provider
 * does not always say when).
 */
export function rememberBlock(quota: StoredQuota, question: string): StoredQuota {
  const short = isShortPause(quota.kind);
  const until = short ? (quota.resetAt ?? Date.now() + 60_000) : nextIstMidnight();
  const settled = short ? { ...quota, resetAt: until } : quota;
  try {
    window.localStorage.setItem(BLOCK_KEY, JSON.stringify({ quota: settled, question, until }));
    window.localStorage.setItem(PENDING_KEY, question);
  } catch {
    /* storage blocked: the refusal simply is not remembered */
  }
  return settled;
}

/**
 * THE QUESTION THAT WAS REFUSED, kept past the refusal itself, so it is never
 * lost: someone who leaves the Ask tab during the wait and comes back later
 * finds it back in the box, ready to send, rather than having to retype it.
 * Cleared once a question is answered.
 */
const PENDING_KEY = "aqi.ask.pending";

export function pendingQuestion(): string {
  try {
    return window.localStorage.getItem(PENDING_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The refusal still in force, or null once it has lifted. */
export function activeBlock(): { quota: StoredQuota; question: string } | null {
  try {
    const raw = window.localStorage.getItem(BLOCK_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as StoredBlock;
    if (!b?.quota || typeof b.until !== "number" || Date.now() >= b.until) {
      window.localStorage.removeItem(BLOCK_KEY);
      return null;
    }
    return { quota: b.quota, question: b.question ?? "" };
  } catch {
    return null;
  }
}

/** The refusal has lifted and the question has been answered: forget both. */
export function clearBlock(): void {
  try {
    window.localStorage.removeItem(BLOCK_KEY);
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to do */
  }
}
