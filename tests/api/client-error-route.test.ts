/**
 * POST /api/client-error — records an error from someone's browser.
 *
 * Unlike /api/event, this one TRUNCATES instead of rejecting: a too-long error
 * is exactly the unusual one we want to see, so it is cut to fit the database
 * CHECK constraint (migration 20) rather than refused. What it must still do:
 *
 *   - require a message
 *   - cut every field to its database limit
 *   - drop the query string and #fragment from the pathname (where personal
 *     data would leak) before it reaches the database
 *   - rate limit one address (a render loop can throw forever)
 *   - not leak database error text to the browser
 *
 * Supabase is faked: `rpc` is a mock standing in for record_client_error().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc }),
}));

import { POST } from "@/app/api/client-error/route";

let ipCounter = 0;
const freshIp = () => `10.2.0.${++ipCounter}`;

function post(body: unknown, ip = freshIp()) {
  return new Request("http://localhost/api/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The arguments of the one record_client_error call. */
const sent = () => {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][0]).toBe("record_client_error");
  return rpc.mock.calls[0][1] as Record<string, string | null>;
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("POST /api/client-error — accepted reports", () => {
  it("records a full report and calls record_client_error with all four fields", async () => {
    const res = await POST(
      post({ message: "render: boom", stack: "Error: boom\n  at X", pathname: "/trends", browser: "Chrome 130" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ recorded: true });
    expect(sent()).toEqual({
      p_message: "render: boom",
      p_stack: "Error: boom\n  at X",
      p_pathname: "/trends",
      p_browser: "Chrome 130",
    });
  });

  it("needs only a message; missing optional fields are sent as null", async () => {
    expect((await POST(post({ message: "boom" }))).status).toBe(200);
    expect(sent()).toEqual({ p_message: "boom", p_stack: null, p_pathname: null, p_browser: null });
  });

  it("treats non-string or blank optional fields as null", async () => {
    await POST(post({ message: "boom", stack: 42, pathname: "   ", browser: { name: "x" } }));
    expect(sent()).toEqual({ p_message: "boom", p_stack: null, p_pathname: null, p_browser: null });
  });

  it("trims whitespace around the message", async () => {
    await POST(post({ message: "  boom \n" }));
    expect(sent().p_message).toBe("boom");
  });

  it("sends only the four known fields, whatever else the body carries", async () => {
    await POST(post({ message: "boom", email: "a@b.com", ip: "1.2.3.4", userId: "u1" }));
    expect(Object.keys(sent()).sort()).toEqual(["p_browser", "p_message", "p_pathname", "p_stack"]);
  });
});

describe("POST /api/client-error — length limits (migration 20 CHECK)", () => {
  it("truncates rather than rejects: message 300, stack 1000, pathname 120, browser 40", async () => {
    const res = await POST(
      post({
        message: "m".repeat(5000),
        stack: "s".repeat(5000),
        pathname: "/" + "p".repeat(5000),
        browser: "b".repeat(500),
      }),
    );
    expect(res.status).toBe(200);
    const args = sent();
    expect(args.p_message).toBe("m".repeat(300));
    expect(args.p_stack).toBe("s".repeat(1000));
    expect(args.p_pathname).toHaveLength(120);
    expect(args.p_browser).toBe("b".repeat(40));
  });

  it("keeps values exactly at the limit unchanged", async () => {
    await POST(post({ message: "m".repeat(300), browser: "b".repeat(40) }));
    expect(sent().p_message).toHaveLength(300);
    expect(sent().p_browser).toHaveLength(40);
  });
});

describe("POST /api/client-error — pathname privacy", () => {
  it.each([
    ["/trends?city=Pune&email=a@b.com", "/trends"],
    ["/map#lat=18.5,lng=73.8", "/map"],
    ["/ask?q=x#frag", "/ask"],
  ])("strips the query string and fragment from %s", async (input, expected) => {
    await POST(post({ message: "boom", pathname: input }));
    expect(sent().p_pathname).toBe(expected);
  });

  it("strips a query string that starts beyond the 120-character limit", async () => {
    const path = "/" + "p".repeat(150) + "?email=a@b.com";
    await POST(post({ message: "boom", pathname: path }));
    const p = sent().p_pathname!;
    expect(p).not.toContain("?");
    expect(p).not.toContain("@");
    expect(p).toHaveLength(120);
  });
});

describe("POST /api/client-error — rejected reports", () => {
  it("rejects a missing, blank or non-string message without calling the database", async () => {
    for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }, { stack: "only a stack" }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/message is required/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    for (const body of ["not json", "", "{message:"]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects JSON arrays, numbers and strings as having no message", async () => {
    for (const body of ["[]", "42", '"boom"']) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  // A body of JSON `null` parses fine, so it needs its own check: reading
  // `payload.message` off null used to crash the route with a 500.
  it("rejects a JSON null body with 400", async () => {
    const res = await POST(post("null"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/client-error — rate limiting", () => {
  it("allows 10 a minute from one address, then answers 429 with Retry-After", async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await POST(post({ message: `boom ${i}` }, ip))).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    const again = await POST(post({ message: "boom" }, ip));
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(rpc).toHaveBeenCalledTimes(10);
  });

  it("does not limit a different address", async () => {
    const ip = freshIp();
    for (let i = 0; i < 11; i++) await POST(post({ message: "boom" }, ip));
    expect((await POST(post({ message: "boom" }, freshIp()))).status).toBe(200);
  });
});

describe("POST /api/client-error — database errors", () => {
  it("answers 502 without leaking the database's error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'new row for relation "client_errors" violates check constraint "client_errors_sizes"' },
    });
    const res = await POST(post({ message: "boom" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Could not record" } });
    expect(JSON.stringify(body)).not.toMatch(/client_errors|constraint|relation/);
    expect(spy.mock.calls.flat().join(" ")).toMatch(/client_errors_sizes/);
    spy.mockRestore();
  });
});
