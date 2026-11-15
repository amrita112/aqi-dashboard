"use client";

/**
 * The signing form.
 *
 * A CLIENT component, unlike the page that holds it, because it has to manage
 * input state and a submit that can fail. The explanatory half of the page
 * stays a server component so none of that text costs the user any JavaScript.
 *
 * REMOVING A NAME IS BY EMAIL (Nov 2026). Signatories used to be shown a
 * withdrawal code with no page to use it on, which confused people. Now the
 * thank-you message gives the privacy address instead; a request there is
 * handled by deleting the row by hand. India's DPDP Act requires that consent
 * can be withdrawn, so this line must stay.
 */

import { useState } from "react";
import { CONTACT_EMAIL } from "@/lib/brand";

type State =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "signed" }
  | { status: "error"; message: string };

export default function PetitionForm({ purpose }: { purpose: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [wantsUpdates, setWantsUpdates] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ status: "sending" });
    try {
      const res = await fetch("/api/petition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, city, wants_updates: wantsUpdates }),
      });
      const body = await res.json();
      if (!res.ok) {
        setState({ status: "error", message: body?.error?.message ?? "Something went wrong." });
        return;
      }
      setState({ status: "signed" });
    } catch {
      setState({ status: "error", message: "Could not reach the server. Please try again." });
    }
  }

  if (state.status === "signed") {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-6">
        <h2 className="text-xl font-semibold text-green-900">Thank you — your name is added.</h2>

        <p className="mt-3 text-sm text-green-900">
          Want your name removed later? Email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>{" "}
          and we will delete it.
        </p>
      </div>
    );
  }

  const sending = state.status === "sending";

  return (
    <form onSubmit={submit} className="rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-xl font-semibold">Add your name</h2>

      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input
            id="name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">
            Used to make sure each person signs once. Not shown publicly, and not shared.
          </p>
        </div>

        <div>
          <label htmlFor="city" className="block text-sm font-medium text-gray-700">
            Which city or town are you in?
          </label>
          <input
            id="city"
            required
            maxLength={60}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">
            Anywhere — places we do not cover yet are the most useful to hear about.
          </p>
        </div>

        {/* Signing and subscribing are separate, and this defaults to off. */}
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={wantsUpdates}
            onChange={(e) => setWantsUpdates(e.target.checked)}
            className="mt-0.5"
          />
          <span>Email me if this goes anywhere. Optional — your signature counts either way.</span>
        </label>
      </div>

      <details className="mt-5 text-sm text-gray-600">
        <summary className="cursor-pointer font-medium text-gray-700">
          What happens to what you enter
        </summary>
        <p className="mt-2">{purpose}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Kept for two years, then deleted automatically.</li>
          <li>Removable at any time with the code shown after you sign.</li>
          <li>Nobody can read the list of signatories through this website.</li>
        </ul>
      </details>

      {state.status === "error" && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={sending}
        className="mt-5 w-full rounded-md bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {sending ? "Adding your name…" : "Add my name"}
      </button>
    </form>
  );
}
