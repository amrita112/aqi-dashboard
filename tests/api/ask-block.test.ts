/**
 * The Ask screen's memory of a refusal (lib/ask-count).
 *
 * Two things went wrong on 19 Oct: a short pause sometimes had no countdown
 * (the provider gave no reset time), and the refused question was lost and
 * had to be retyped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { activeBlock, clearBlock, pendingQuestion, rememberBlock } from "@/lib/ask-count";
import { quotaMessage } from "@/lib/ai/quota";

describe("remembering a refusal", () => {
  beforeEach(() => window.localStorage.clear());

  it("gives a short pause a reset time even when the provider sent none", () => {
    const settled = rememberBlock(quotaMessage("provider_minute", null), "is it bad now?");
    expect(settled.resetAt).toBeGreaterThan(Date.now() + 50_000);
    expect(activeBlock()?.question).toBe("is it bad now?");
  });

  it("keeps the refused question after the block itself has lifted", () => {
    rememberBlock(quotaMessage("per_minute", Date.now() - 1), "run tomorrow?");
    expect(activeBlock()).toBeNull();
    expect(pendingQuestion()).toBe("run tomorrow?");
  });

  it("forgets the question once one is answered", () => {
    rememberBlock(quotaMessage("per_minute", Date.now() + 30_000), "run tomorrow?");
    clearBlock();
    expect(pendingQuestion()).toBe("");
    expect(activeBlock()).toBeNull();
  });
});
