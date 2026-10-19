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
import {
  activeBlock,
  clearBlock,
  countQuestion,
  questionsAskedToday,
  rememberBlock,
  type StoredQuota,
} from "@/lib/ask-count";
import { ASK_DAILY_LIMIT, isShortPause } from "@/lib/ai/quota";
import { loadPrefs, type Prefs } from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import AnswerChart from "@/components/AnswerChart";
import type { AnswerChart as ChartSpec, Provenance } from "@/lib/ai/chart";
import { trackFailure, trackQuestion, type FailureReason } from "@/lib/analytics";
import {
  addToHistory,
  loadHistory,
  shortAge,
  suggestNext,
  type AskEntry,
} from "@/lib/ask-history";

/** The server's quota object; one type with what the device remembers. */
type QuotaInfo = StoredQuota;

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
  /**
   * Daily allowance. Known from the start (it is a shared constant), so the
   * "questions left" line shows on every visit rather than only after an
   * answer; the server's figure still overrides it when one arrives.
   */
  const [dailyLimit, setDailyLimit] = useState<number>(ASK_DAILY_LIMIT);
  const [askedToday, setAskedToday] = useState(0);
  const [state, setState] = useState<State>({ status: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    // Read in an effect because localStorage does not exist while rendering on
    // the server.
    setAskedToday(questionsAskedToday());
    const h = loadHistory();
    setHistory(h);
    // A REFUSAL STILL IN FORCE COMES FIRST. Otherwise reopening the tab
    // restored the last good answer and looked like the limit had lifted,
    // until the next question was refused again.
    const block = activeBlock();
    if (block) {
      setState({
        status: "error",
        question: block.question,
        message: block.quota.message,
        unavailable: false,
        quota: block.quota,
      });
      return;
    }
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
      // Cleared on send, not on success. The question is already on screen in
      // the bubble above; leaving it in the box invited re-sending it.
      setQuestion("");
      const p = loadPrefs();
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: p ? `${trimmed}\n\n(I am in ${p.city}, near ${p.anchor.name}.)` : trimmed,
            // The coordinates travel as data, so a place with no station of its
            // own still resolves to the three nearest — the same thing the home
            // screen does for the same pin.
            place: p
              ? {
                  latitude: p.anchor.latitude,
                  longitude: p.anchor.longitude,
                  label: p.anchor.name,
                  city: p.city,
                  measurement: p.measurement,
                }
              : undefined,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          const quota =
            body?.error?.code === "out_of_questions" ? (body.error.quota as QuotaInfo) : null;
          // A FIXED SET OF REASONS, never the question or the message. The
          // point is to learn how often we decline and why, not to accumulate
          // a record of what people are worried about.
          const reason: FailureReason = quota
            ? "out_of_questions"
            : res.status === 503
              ? "provider_error"
              : "no_data";
          trackFailure(reason);
          trackQuestion(quota ? "quota" : "error", null);
          // Kept on the device until it lifts; see lib/ask-count.
          if (quota) rememberBlock(quota, trimmed);
          setState({
            status: "error",
            question: trimmed,
            message: body?.error?.message ?? "Something went wrong.",
            unavailable: res.status === 503,
            quota,
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
        if (typeof body.meta?.daily_limit === "number") setDailyLimit(body.meta.daily_limit);
        // An answer means any earlier refusal has lifted.
        clearBlock();
        // Counted here, not read back from the server — see lib/ask-count.
        setAskedToday(countQuestion());
        // The LAST tool is the one the sentence is about. "none" means the
        // model answered without looking anything up, which is usually a
        // refusal — worth knowing separately from a tool-backed answer.
        const lastTool = entry.tools.length ? entry.tools[entry.tools.length - 1] : null;
        trackQuestion(lastTool ? "answered" : "no_tool", lastTool);
        setHistory((h) => addToHistory(entry, h));
        setState({ status: "answered", entry, cached: false });
      } catch {
        trackFailure("network");
        trackQuestion("error", null);
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
  // Zero while this device's own daily allowance is spent, whatever the local
  // tally says: the tally and the server can disagree (lib/ask-count), and the
  // screen must not offer questions it has just been told are gone.
  const outForToday = state.status === "error" && state.quota?.kind === "per_day";
  const questionsLeft = outForToday ? 0 : Math.max(0, dailyLimit - askedToday);
  const nextQuestion =
    state.status === "answered" ? suggestNext(state.entry.tools, place) : null;

  return (
    // CAPPED WIDTH EVEN ON A LAPTOP. The cards stretch usefully; a line of
    // text does not — an answer running the full width of a monitor is harder
    // to read, not easier. The column stays at a comfortable measure and the
    // extra space is left empty.
    // 100dvh, NOT 100vh. On iOS, 100vh is the viewport as it would be with the
    // browser chrome hidden — taller than what you can actually see — so a
    // column sized to it hangs below the screen and takes whatever sits at its
    // end with it. dvh is the height that is really there.
    <div className="mx-auto flex min-h-[calc(100dvh-7rem)] w-full max-w-2xl flex-col">
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
                {provenanceLine(state.entry) ??
                  "Answered without looking anything up — these are the AI's own words, not this app's data."}
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
            {/* A COUNTDOWN ONLY FOR A SHORT PAUSE. A daily limit used to show
                one too, which sat under "hit its free daily limit" and
                contradicted it. Daily limits say when instead. */}
            {isShortPause(state.quota.kind) && state.quota.resetAt ? (
              <Countdown until={state.quota.resetAt} />
            ) : !isShortPause(state.quota.kind) ? (
              <p className="mt-2 font-medium">You can ask again after midnight.</p>
            ) : null}
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

      {/* SAID OUT LOUD, both of them. Amrita watched someone refer back to
          their previous question and get an answer that made no sense, because
          every question is answered on its own — there is no conversation here
          to refer to. And the allowance was invisible until it ran out, which
          is the worst moment to learn about it. */}
      {/* ONE SIZE UP (was text-xs), and the count on a line of its own so it
          is not lost in the middle of a paragraph. */}
      <p className="mt-4 px-1 text-sm text-gray-500">
        Each question is answered on its own. The AI cannot see what you asked before, so
        it does not have your previous questions and its answers in context.
        <span className="mt-1 block">
          <span className="font-medium text-gray-700">
            {questionsLeft} {questionsLeft === 1 ? "question" : "questions"} left today.
          </span>{" "}
          A future version will let you pay for unlimited questions.
        </span>
      </p>

      {/* SAID HERE, NOT ONLY ON A POLICY PAGE. This is the one place in the app
          where something a person has WRITTEN leaves the device, along with the
          coordinates of the place they picked — and two screens away, Settings
          says their answers are kept on this device only. Both are true, and
          together they mislead unless this sentence sits next to the box it is
          about. Someone typing "is the air bad where my daughter goes to
          school" should know where that sentence goes before they send it. */}
      <p className="mt-2 px-1 text-sm text-gray-500">
        Your question and the location you chose are sent to Groq to be answered.{" "}
        <Link href="/privacy" className="underline">
          What that means
        </Link>
        .
      </p>

      {/* Pinned above the tab bar, where a thumb and a phone keyboard expect it.
          NOT bottom-0: a sticky element pins to the SCROLLPORT, and the tab bar
          is `fixed` over the bottom 80px of it — so the whole question box sat
          underneath the tab bar, off screen. On an iPhone that left the Ask tab
          with a title, some empty space and no way to ask anything, which is
          what Ruju recorded.
          It was always wrong; it became invisible when the tab bar went from
          95% opaque to solid on 13 Oct, so the box stopped showing through.
          bottom-20 matches the pb-20 the shell already reserves for the bar;
          on a laptop the bar is a left sidebar and nothing overlaps. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="sticky bottom-20 mt-4 flex items-end gap-2 bg-gray-50 pb-2 pt-3 lg:bottom-0"
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
    // Was missing, so a short provider pause fell through to the default and
    // said "free daily limit" right above a one-minute countdown.
    case "provider_minute":
      return "That was a few questions in quick succession for the AI service. It needs a short break.";
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
