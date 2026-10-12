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

beforeEach(() => track.mockReset());

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
