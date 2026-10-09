"use client";

/**
 * "My city isn't here."
 *
 * The seven cities are where the monitoring network is dense enough to forecast
 * from, which is a fact about CPCB's network rather than a judgement about
 * anywhere else. Someone in Indore opening this app finds nothing for them and
 * no way to say so — and they are exactly the person whose demand is worth
 * counting, because the case for denser measurement is made of people like
 * them.
 *
 * THE PROMISE IS SPECIFIC AND THEREFORE KEEPABLE: fifty requests for any place
 * in India and we add it. A vague "we'll consider it" would cost nothing and
 * mean nothing.
 *
 * The count is public; the people are not. petition_signatures has no SELECT
 * policy, and the count comes from a SECURITY DEFINER function that returns an
 * integer, so "47 people have asked" is sayable without anyone being able to
 * ask who.
 */

import { useEffect, useState } from "react";

type State =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; count: number; already: boolean }
  | { status: "error"; message: string };

export default function CityRequestForm({ threshold = 50 }: { threshold?: number }) {
  const [open, setOpen] = useState(false);
  const [city, setCity] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [state, setState] = useState<State>({ status: "idle" });

  // Show the running total as they type, so the ask is visibly collective
  // rather than a message into a void.
  useEffect(() => {
    const q = city.trim();
    if (q.length < 3) {
      setCount(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      fetch(`/api/city-request?city=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((b) => !cancelled && !b?.error && setCount(b.data.count))
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [city]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ status: "sending" });
    try {
      const res = await fetch("/api/city-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), city: city.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setState({ status: "error", message: body?.error?.message ?? "Something went wrong." });
        return;
      }
      setState({ status: "done", count: body.data.count, already: body.data.already });
    } catch {
      setState({ status: "error", message: "Could not reach the server." });
    }
  }

  if (state.status === "done") {
    const left = Math.max(0, threshold - state.count);
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900">
        <p className="font-medium">
          {state.already ? "You had already asked for" : "Thank you. We have counted your request for"}{" "}
          {city.trim()}.
        </p>
        <p className="mt-1">
          {state.count} {state.count === 1 ? "person has" : "people have"} asked so far.
          {left > 0
            ? ` ${left} more and we will add it.`
            : " That is 50 or more, so it is on the list."}
        </p>
        <p className="mt-2">
          Ask your friends and family in {city.trim()} to do the same.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-blue-700 underline"
      >
        My city isn&apos;t listed
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm text-gray-700">
        Tell us where you would like us to cover. If we get{" "}
        <strong>50 requests for any location in India</strong>, we will add it — so ask your
        friends and family to do the same.
      </p>

      <div className="mt-3 space-y-2">
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Which city?"
          maxLength={60}
          required
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        {count !== null && (
          <p className="text-xs text-gray-600">
            {count === 0
              ? "Nobody has asked for this one yet. You would be first."
              : `${count} ${count === 1 ? "person has" : "people have"} already asked for this.`}
          </p>
        )}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={80}
          required
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email, so we can tell you when it is added"
          required
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      {state.status === "error" && (
        <p className="mt-2 text-sm text-red-700">{state.message}</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={state.status === "sending"}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {state.status === "sending" ? "Sending…" : "Ask for this city"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-gray-600 underline"
        >
          Cancel
        </button>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Your email is used only to tell you when your city is added, and is deleted with the
        request. The count for each city is public; who asked is not.
      </p>
    </form>
  );
}
