/**
 * The error reporter.
 *
 * Everything here protects against the same failure: a reporter that makes a
 * broken page worse. An error inside a render fires again on every retry, and
 * an unhandled rejection in an interval fires forever — so the dangerous bug
 * is not a missing report, it is a flood that fills the table and hides
 * everyone else's problem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

/** Fresh module per test, because the de-duplication state is module-level. */
async function freshReporter() {
  const mod = await import("@/lib/report-error");
  return mod.reportError;
}

function bodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(((call as unknown[])[1] as RequestInit).body as string),
  );
}

describe("reportError", () => {
  it("posts the message, stack and route", async () => {
    const report = await freshReporter();
    report(new Error("boom"), "render");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [body] = bodies();
    expect(body.message).toBe("render: boom");
    expect(typeof body.stack).toBe("string");
  });

  it("reports a repeated error only once", async () => {
    const report = await freshReporter();
    for (let i = 0; i < 10; i++) report(new Error("same"), "render");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps distinct errors per page load", async () => {
    const report = await freshReporter();
    for (let i = 0; i < 20; i++) report(new Error(`different ${i}`));
    // Five is the cap; without one, a loop throwing varying messages would
    // defeat the de-duplication above.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("truncates a huge message rather than letting the insert be rejected", async () => {
    const report = await freshReporter();
    report(new Error("x".repeat(5000)));
    const [body] = bodies();
    // The database CHECK rejects over 300, and a rejected insert loses exactly
    // the unusual error that was worth seeing.
    expect((body.message as string).length).toBeLessThanOrEqual(300);
  });

  it("never sends a query string", async () => {
    const report = await freshReporter();
    report(new Error("boom"));
    const [body] = bodies();
    expect(String(body.pathname ?? "")).not.toContain("?");
  });

  it("does not throw when the endpoint rejects", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const report = await freshReporter();
    // A reporter that throws inside an error handler is an infinite loop.
    expect(() => report(new Error("boom"))).not.toThrow();
  });

  it("handles a thrown non-Error", async () => {
    const report = await freshReporter();
    report("just a string");
    expect(bodies()[0].message).toBe("just a string");
  });
});
