/**
 * Tests for the Ask tab's cached history.
 *
 * The two things that matter: a cached answer must never be mistaken for a
 * fresh one, and the follow-up suggestion must only ever propose a question the
 * tools can actually answer.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ASK_HISTORY_KEY,
  MAX_AGE_MS,
  MAX_HISTORY,
  addToHistory,
  loadHistory,
  shortAge,
  suggestNext,
  type AskEntry,
} from "@/lib/ask-history";

function entry(question: string, asked_at = Date.now()): AskEntry {
  return { question, answer: `answer to ${question}`, tools: ["forecast"], chart: null, provenance: null, asked_at };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("history storage", () => {
  it("round-trips an entry", () => {
    addToHistory(entry("is it bad today?"), []);
    const back = loadHistory();
    expect(back).toHaveLength(1);
    expect(back[0].answer).toBe("answer to is it bad today?");
  });

  it("puts the newest first and de-duplicates by question", () => {
    let h = addToHistory(entry("a"), []);
    h = addToHistory(entry("b"), h);
    h = addToHistory(entry("a"), h);
    expect(h.map((e) => e.question)).toEqual(["a", "b"]);
  });

  it("de-duplicates case- and whitespace-insensitively", () => {
    let h = addToHistory(entry("Is It Bad?"), []);
    h = addToHistory(entry("  is it bad?  "), h);
    expect(h).toHaveLength(1);
  });

  it("caps the list", () => {
    let h: AskEntry[] = [];
    for (let i = 0; i < MAX_HISTORY + 4; i++) h = addToHistory(entry(`q${i}`), h);
    expect(h).toHaveLength(MAX_HISTORY);
  });

  it("drops answers old enough to be wrong", () => {
    // A cached "today" from yesterday is not a stale convenience, it is a false
    // statement, so age is enforced on read rather than trusted on write.
    const stale = entry("yesterday's question", Date.now() - MAX_AGE_MS - 1000);
    window.localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify([stale]));
    expect(loadHistory()).toHaveLength(0);
  });

  it("survives junk in storage", () => {
    window.localStorage.setItem(ASK_HISTORY_KEY, "not json");
    expect(loadHistory()).toEqual([]);
    window.localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify({ not: "an array" }));
    expect(loadHistory()).toEqual([]);
  });

  it("survives storage being unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(() => loadHistory()).not.toThrow();
    expect(loadHistory()).toEqual([]);
    if (original) Object.defineProperty(window, "localStorage", original);
  });
});

describe("suggested follow-up", () => {
  it("offers a question the tools can answer, keyed off the tool that ran", () => {
    expect(suggestNext(["rest_of_today"], "Bandra")).toMatch(/tomorrow/i);
    expect(suggestNext(["best_hour"], "Bandra")).toBe("I can't go out then. What about the day after?");
    expect(suggestNext(["forecast"], "Bandra")).toContain("Bandra");
    expect(suggestNext(["history"], "Bandra")).toMatch(/better or worse/i);
  });

  it("keys off the LAST tool when several ran", () => {
    expect(suggestNext(["current_aqi", "best_hour"], "Pune")).toMatch(/day after/i);
  });

  it("offers nothing rather than something unanswerable", () => {
    expect(suggestNext([], "Pune")).toBeNull();
    expect(suggestNext(["something_new"], "Pune")).toBeNull();
  });
});

describe("age wording", () => {
  it("reads naturally at each scale", () => {
    expect(shortAge(Date.now())).toBe("just now");
    expect(shortAge(Date.now() - 4 * 60_000)).toBe("4 min ago");
    expect(shortAge(Date.now() - 3 * 3_600_000)).toBe("3 h ago");
  });
});

describe("suggestion wording", () => {
  it("uses no em dashes, which read badly in a chip", () => {
    const tools = ["rest_of_today", "best_hour", "forecast", "rank_places", "history", "compare", "current_aqi"];
    for (const t of tools) {
      const q = suggestNext([t], "Bandra");
      if (q) expect(q).not.toMatch(/—/);
    }
  });
});
