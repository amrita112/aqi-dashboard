"use client";

/**
 * The question box.
 *
 * Deliberately one question at a time rather than a chat transcript. The
 * answers are two sentences drawn from fixed tools, not a conversation, and
 * presenting them as a chat would promise a back-and-forth the five tools
 * cannot have. Ask, read, then either go home or ask another.
 *
 * The user's place is passed as context so "is it bad tomorrow?" has a
 * referent without them having to name their city every time.
 *
 * DEGRADES HONESTLY. With no model key configured the endpoint returns 503,
 * and this says so plainly rather than showing a dead input — the rest of the
 * app is unaffected and the message says that too.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { loadPrefs, type Prefs } from "@/lib/prefs";

interface Answer {
  question: string;
  answer: string;
  tools_used: { name: string }[];
}

type State =
  | { status: "idle" }
  | { status: "asking" }
  | { status: "answered"; result: Answer }
  | { status: "error"; message: string; unavailable: boolean };

export default function AskScreen() {
  const params = useSearchParams();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  // A suggested question arrives as ?q= from the home screen. Ask it once,
  // rather than making the user press the button on something they picked.
  useEffect(() => {
    const q = params.get("q");
    if (q && !asked.current) {
      asked.current = true;
      setQuestion(q);
      void ask(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setState({ status: "asking" });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: prefs ? `${trimmed}\n\n(I am in ${prefs.city}, near ${prefs.anchor.name}.)` : trimmed,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setState({
          status: "error",
          message: body?.error?.message ?? "Something went wrong.",
          unavailable: res.status === 503,
        });
        return;
      }
      setState({ status: "answered", result: { ...body.data, question: trimmed } });
    } catch {
      setState({ status: "error", message: "Could not reach the server.", unavailable: false });
    }
  }

  function askAnother() {
    setState({ status: "idle" });
    setQuestion("");
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Ask about the air</h1>
        <Link href="/" className="text-sm text-blue-700 underline">
          Home
        </Link>
      </header>

      {state.status === "answered" ? (
        <>
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">{state.result.question}</p>
            <p className="mt-3 text-lg leading-relaxed">{state.result.answer}</p>
            {state.result.tools_used?.length > 0 && (
              <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
                Answered using {state.result.tools_used.map((t) => t.name).join(", ")} — every
                number comes from the measurements, not from the model.
              </p>
            )}
          </section>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={askAnother}
              className="flex-1 rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700"
            >
              Ask another
            </button>
            <Link
              href="/"
              className="flex-1 rounded-md border border-gray-300 px-4 py-2.5 text-center font-medium hover:bg-gray-50"
            >
              Back to home
            </Link>
          </div>
        </>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <textarea
              ref={inputRef}
              rows={3}
              maxLength={500}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                prefs
                  ? `e.g. Is tomorrow worse than today in ${prefs.city}?`
                  : "e.g. Is tomorrow worse than today in Delhi?"
              }
              className="w-full rounded-md border border-gray-300 px-3 py-2"
            />
            <button
              type="submit"
              disabled={state.status === "asking" || !question.trim()}
              className="mt-3 w-full rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {state.status === "asking" ? "Thinking…" : "Ask"}
            </button>
          </form>

          {state.status === "error" && (
            <div
              className={`rounded-md px-4 py-3 text-sm ${
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

          <p className="text-xs text-gray-500">
            Answers are built from the same measurements the rest of the app uses. The model
            chooses what to look up and writes the sentence; it never invents a number.
          </p>
        </>
      )}
    </div>
  );
}
