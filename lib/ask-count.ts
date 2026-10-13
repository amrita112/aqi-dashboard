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
