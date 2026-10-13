/**
 * Tests for what the app measures.
 *
 * The thing worth protecting here is not that events fire — it is that they
 * never carry the question. An app arguing that it does not overclaim should
 * not quietly accumulate a record of what its users are worried about, and
 * "is the air bad where my daughter goes to school" is the kind of thing that
 * would end up in such a log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
vi.mock("@vercel/analytics", () => ({ track: (...a: unknown[]) => track(...a) }));

import { trackFailure, trackInstalled, trackQuestion } from "@/lib/analytics";

// Our own sink, stubbed. Without this the real fetch is left in flight and
// happy-dom aborts it at teardown, which prints a stack trace per test.
const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

beforeEach(() => {
  track.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

/** The JSON bodies posted to /api/event during one test. */
function posted(): { name: string; detail: string | null }[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(((call as unknown[])[1] as RequestInit).body as string),
  );
}

describe("what is sent", () => {
  it("records the tool that answered, and nothing else", () => {
    trackQuestion("answered", "best_hour");
    expect(track).toHaveBeenCalledWith("question", {
      outcome: "answered",
      tool: "best_hour",
    });
  });

  it("uses a value rather than null when no tool ran", () => {
    // null properties are dropped by the dashboard, which would make
    // "answered without a tool" invisible — and that case is a refusal.
    trackQuestion("no_tool", null);
    expect(track).toHaveBeenCalledWith("question", { outcome: "no_tool", tool: "none" });
  });

  it("records a failure as a fixed reason", () => {
    trackFailure("out_of_questions");
    expect(track).toHaveBeenCalledWith("question_failed", { reason: "out_of_questions" });
  });

  it("separates an install from our button from one through the browser menu", () => {
    // If these diverge, the install hint is not doing its job.
    trackInstalled("prompt");
    trackInstalled("browser");
    expect(track).toHaveBeenNthCalledWith(1, "installed", { source: "prompt" });
    expect(track).toHaveBeenNthCalledWith(2, "installed", { source: "browser" });
  });
});

describe("what is never sent", () => {
  it("sends only a fixed set of keys, with no free text", () => {
    // Asserted STRUCTURALLY rather than by substring: an earlier version
    // searched the payload for "answer" and matched its own "answered"
    // outcome, which is a test failing on its own vocabulary.
    trackQuestion("answered", "history");
    trackFailure("no_data");
    trackInstalled("browser");

    const allowedKeys = new Set(["outcome", "tool", "reason", "source"]);
    for (const [, props] of track.mock.calls as [string, Record<string, unknown>][]) {
      for (const [key, value] of Object.entries(props)) {
        expect(allowedKeys.has(key), `unexpected key "${key}"`).toBe(true);
        // Every value is a short enum member. Free text is how a question
        // would leak, so length is the guard.
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeLessThan(32);
        expect(value).not.toMatch(/\s/);
      }
    }
  });

  it("never throws, whatever the provider does", () => {
    // Analytics must not break the thing it is measuring.
    track.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => trackQuestion("answered", "forecast")).not.toThrow();
    expect(() => trackFailure("network")).not.toThrow();
    expect(() => trackInstalled("prompt")).not.toThrow();
    track.mockReset();
  });
});

describe("the Supabase sink", () => {
  // Vercel puts custom events behind Pro and track() drops them silently when
  // they are unavailable, so for months this file tested a sink that recorded
  // nothing. These assert the one that actually stores a row.
  it("posts every event to /api/event as well", () => {
    trackQuestion("answered", "best_hour");
    trackFailure("no_data");
    trackInstalled("prompt");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect((call as unknown[])[0]).toBe("/api/event");
    }
    expect(posted()).toEqual([
      { name: "question", detail: "best_hour" },
      { name: "question_failed", detail: "no_data" },
      { name: "installed", detail: "prompt" },
    ]);
  });

  it("records an answer with no tool behind it as 'none'", () => {
    // This test previously asserted detail: "no_tool", which was the bug
    // rather than the intent — it came from `tool ?? outcome`, the same
    // expression that recorded a quota refusal as `question / quota`. The
    // detail column means "which tool", so an answer with no tool is "none".
    trackQuestion("no_tool", null);
    expect(posted()).toEqual([{ name: "question", detail: "none" }]);
  });

  it("sends tokens the database CHECK constraint will accept", () => {
    // Migration 19 constrains detail to ^[a-z0-9_]+$, at most 40 characters.
    // A tool renamed to something with a hyphen or a space would be rejected
    // at insert and the count would vanish silently.
    trackQuestion("answered", "rest_of_today");
    trackFailure("provider_error");
    trackInstalled("browser");
    for (const body of posted()) {
      expect(["installed", "question", "question_failed"]).toContain(body.name);
      if (body.detail !== null) expect(body.detail).toMatch(/^[a-z0-9_]{1,40}$/);
    }
  });

  it("carries no question text, place or identifier", () => {
    trackQuestion("answered", "compare");
    for (const body of posted()) {
      expect(Object.keys(body).sort()).toEqual(["detail", "name"]);
    }
  });

  it("survives the endpoint being down", () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    // Measuring the app must never break it.
    expect(() => trackInstalled("browser")).not.toThrow();
  });
});

describe("refusals are not answers", () => {
  // The table holds a name and ONE short token. An outcome written into the
  // token position reads as a tool name: `question / quota` looked exactly
  // like "the quota tool answered this", which poisons the only question the
  // table exists to answer.
  it("records no question row when the app refused", () => {
    trackQuestion("quota", null);
    trackQuestion("error", null);
    expect(posted().filter((b) => b.name === "question")).toEqual([]);
  });

  it("still records the refusal through the failure path", () => {
    trackFailure("out_of_questions");
    expect(posted()).toEqual([
      { name: "question_failed", detail: "out_of_questions" },
    ]);
  });

  it("counts an answer with no tool behind it, which is not a refusal", () => {
    trackQuestion("no_tool", null);
    expect(posted()).toEqual([{ name: "question", detail: "none" }]);
  });
});
