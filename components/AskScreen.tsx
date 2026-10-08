"use client";

/**
 * The question box.
 *
 * Rebuilt to the 7 Oct mockup: the app's name, the question as a dark bubble,
 * the answer beneath it, a grey provenance line, the chart, one suggested
 * follow-up, and the input pinned at the bottom where a phone keyboard expects
 * it.
 *
 * STILL ONE QUESTION AT A TIME, not a chat transcript. The answers are two
 * sentences drawn from fixed tools; presenting them as a conversation would
 * promise a back-and-forth the tools cannot have. Recent questions are chips
 * that restore a cached answer rather than turns in a thread.
 *
 * RE-READING COSTS NOTHING. The rate limit is three questions a minute, and a
 * fair share of what people ask they have asked already. Answers are cached in
 * the browser, so tapping a recent question never touches the quota.
 *
 * DEGRADES HONESTLY. With no model key the endpoint returns 503 and this says
 * so plainly rather than showing a dead input; when the quota is gone it
 * explains that it is a free app rather than showing an error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { loadPrefs, type Prefs } from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import AnswerChart from "@/components/AnswerChart";
import type { AnswerChart as ChartSpec, Provenance } from "@/lib/ai/chart";
import {
  addToHistory,
  loadHistory,
  shortAge,
  suggestNext,
  type AskEntry,
} from "@/lib/ask-history";

interface QuotaInfo {
  kind: "per_minute" | "per_day" | "shared_day" | "provider";
  message: string;
  resetAt: number | null;
  future: string;
}

type State =
  | { status: "idle" }
  | { status: "asking"; question: string }
  | { status: "answered"; entry: AskEntry; cached: boolean }
  | { status: "error"; question: string; message: string; unavailable: boolean; quota: QuotaInfo | null };

export default function AskScreen() {
  const params = useSearchParams();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<AskEntry[]>([]);
  const [state, setState] = useState<State>({ status: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    const h = loadHistory();
    setHistory(h);
    // Restore the most recent answer, so a remount — a hot reload in
    // development, a tab restored from memory on a phone — does not look like
    // the app silently discarding what the person just asked.
    if (h.length) setState({ status: "answered", entry: h[0], cached: true });
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // A question already answered comes from the cache: instant, and it does
      // not spend one of three questions a minute.
      const hit = loadHistory().find(
        (e) => e.question.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (hit) {
        setState({ status: "answered", entry: hit, cached: true });
        return;
      }

      setState({ status: "asking", question: trimmed });
      const p = loadPrefs();
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: p
              ? `${trimmed}\n\n(I am in ${p.city}, near ${p.anchor.name}. ` +
                `I want answers in ${p.measurement === "pm25" ? "PM2.5 concentration (µg/m³)" : "AQI"} unless I ask otherwise.)`
              : trimmed,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          setState({
            status: "error",
            question: trimmed,
            message: body?.error?.message ?? "Something went wrong.",
            unavailable: res.status === 503,
            quota: body?.error?.code === "out_of_questions" ? (body.error.quota as QuotaInfo) : null,
          });
          return;
        }
        const entry: AskEntry = {
          question: trimmed,
          answer: body.data.answer,
          tools: (body.data.tools_used ?? []).map((t: { name: string }) => t.name),
          chart: (body.data.chart ?? null) as ChartSpec | null,
          provenance: (body.data.provenance ?? null) as Provenance | null,
          asked_at: Date.now(),
        };
        setHistory((h) => addToHistory(entry, h));
        setState({ status: "answered", entry, cached: false });
        setQuestion("");
      } catch {
        setState({
          status: "error",
          question: trimmed,
          message: "Could not reach the server.",
          unavailable: false,
          quota: null,
        });
      }
    },
    [],
  );

  // A suggested question arrives as ?q= from the home screen. Ask it once.
  useEffect(() => {
    const q = params.get("q");
    if (q && !asked.current) {
      asked.current = true;
      setQuestion(q);
      void ask(q);
    }
  }, [params, ask]);

  const place = prefs?.anchor.name ?? prefs?.city ?? "your area";
  const nextQuestion =
    state.status === "answered" ? suggestNext(state.entry.tools, place) : null;

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col">
      <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>

      <div className="mt-4 flex-1 space-y-4">
        {(state.status === "asking" ||
          state.status === "answered" ||
          state.status === "error") && (
          <p className="ml-auto max-w-[92%] rounded-2xl rounded-br-sm bg-gray-900 px-4 py-3 text-sm text-white">
            {state.status === "answered" ? state.entry.question : state.question}
          </p>
        )}

        {state.status === "asking" && (
          <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
            Looking it up…
          </p>
        )}

        {state.status === "answered" && (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-base leading-relaxed">{state.entry.answer}</p>
            </section>

            {/* Where the numbers came from, in the grey the mockup uses. Says
                "saved answer" when nothing was asked, so a cached reply is
                never mistaken for a fresh lookup. */}
            <p className="flex items-start gap-1.5 px-1 text-xs text-gray-500">
              <span aria-hidden className="mt-px inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-gray-400 text-[9px]">
                i
              </span>
              <span>
                {provenanceLine(state.entry) ?? "Answered without looking anything up."}
                {state.cached && ` · saved answer, ${shortAge(state.entry.asked_at)}`}
              </span>
            </p>

            {state.entry.chart && <AnswerChart chart={state.entry.chart} />}

            {nextQuestion && (
              <div>
                <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Ask next
                </p>
                <button
                  type="button"
                  onClick={() => void ask(nextQuestion)}
                  className="mt-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm text-gray-900 hover:bg-gray-50"
                >
                  {nextQuestion}
                </button>
              </div>
            )}
          </>
        )}

        {state.status === "error" && state.quota && (
          /* Out of questions is not an error, so it does not get the red
             treatment: the app is working and the person has reached the end
             of a free allowance. Red would read as "broken", and the next
             thing they would stop trusting is the forecast. */
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <p className="font-medium">{quotaHeadline(state.quota.kind)}</p>
            <p className="mt-1">{state.quota.future}</p>
            {state.quota.resetAt && <Countdown until={state.quota.resetAt} />}
            <p className="mt-2">
              Everything else works —{" "}
              <Link href="/" className="underline">
                the forecast
              </Link>
              ,{" "}
              <Link href="/map" className="underline">
                map
              </Link>{" "}
              and{" "}
              <Link href="/trends" className="underline">
                trends
              </Link>{" "}
              do not use AI.
            </p>
          </div>
        )}

        {state.status === "error" && !state.quota && (
          <div
            className={`rounded-xl p-4 text-sm ${
              state.unavailable ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800"
            }`}
          >
            <p>{state.message}</p>
            {state.unavailable && (
              <p className="mt-1">
                Everything else in the app works —{" "}
                <Link href="/" className="underline">
                  go back to the forecast
                </Link>
                .
              </p>
            )}
          </div>
        )}

        {/* Recent questions. Tapping one is free. */}
        {history.length > 1 && (
          <div className="pt-2">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Recent
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {history
                .filter((e) =>
                  state.status === "answered" ? e.question !== state.entry.question : true,
                )
                .slice(0, 4)
                .map((e) => (
                  <button
                    key={e.asked_at}
                    type="button"
                    onClick={() => setState({ status: "answered", entry: e, cached: true })}
                    className="max-w-full truncate rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    {e.question}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Pinned to the bottom, where a thumb and a phone keyboard expect it. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="sticky bottom-0 mt-4 flex items-end gap-2 bg-gray-50 pb-2 pt-3"
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. A question is one line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
          placeholder="Ask about the air…"
          className="min-h-[2.75rem] flex-1 resize-none rounded-full border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-gray-400"
        />
        <button
          type="submit"
          disabled={!question.trim() || state.status === "asking"}
          aria-label="Ask"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-700 text-white disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}

/**
 * "3 Mumbai stations · hourly pattern fitted on 2019–2026 · latest reading 17 h
 * ago" — what the mockup asks for, and what someone could actually check.
 *
 * The old line named our internal tool names, which mean nothing outside this
 * codebase and told the reader nothing about where the numbers came from.
 */
function provenanceLine(entry: AskEntry): string | null {
  const p = entry.provenance;
  if (!p) return entry.tools.length ? "Built from the measurements in this app." : null;
  const parts: string[] = [];
  if (p.stations !== null) {
    parts.push(
      `${p.stations} ${p.place ?? ""} station${p.stations === 1 ? "" : "s"}`.replace(/\s+/g, " ").trim(),
    );
  } else if (p.place) {
    parts.push(p.place);
  }
  if (p.period) parts.push(p.period);
  if (p.latestAgeHours !== null) {
    const h = Math.round(p.latestAgeHours);
    parts.push(h < 48 ? `latest reading ${h} h ago` : `latest reading ${Math.round(h / 24)} days ago`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** A short lead per exhaustion kind; the shared explanation follows it. */
function quotaHeadline(kind: QuotaInfo["kind"]): string {
  switch (kind) {
    case "per_minute":
      return "You asked a few questions in quick succession. The AI agent needs a short break.";
    case "per_day":
      return "You have used your questions for today.";
    case "shared_day":
      return "Today's shared pool of questions is used up.";
    default:
      return "The AI service has hit its free daily limit.";
  }
}

/**
 * Ticks down to when asking is worth trying again.
 *
 * Only for the limits that recover in minutes; "try again tomorrow" with a
 * live second counter would be absurd, so the caller passes null for those.
 */
function Countdown({ until }: { until: number }) {
  const [left, setLeft] = useState(() => Math.max(0, until - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, until - Date.now())), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (left <= 0) return <p className="mt-2 font-medium">You can ask again now.</p>;
  const secs = Math.ceil(left / 1000);
  return <p className="mt-2">Try again in {secs >= 60 ? `${Math.ceil(secs / 60)} min` : `${secs}s`}.</p>;
}
