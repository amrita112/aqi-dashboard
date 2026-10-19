"use client";

/**
 * Type where you live. The map comes after.
 *
 * All three of the first testers said finding their own home on the setup map
 * was hard, and one of them put her finger on why: "that could be because I
 * don't know the surrounding locations too well yet". Recognising your own
 * neighbourhood from an unlabelled street map, panned through a phone-sized
 * window, is a genuinely hard task that the app was asking of everyone before
 * it showed them anything useful.
 *
 * SEARCH ON SUBMIT, NOT AS YOU TYPE. Two reasons, and the second is the real
 * one: Nominatim's usage policy forbids per-keystroke autocomplete for free
 * users, and honouring that is the price of the service being free. It also
 * happens to suit a PIN code, which is only meaningful once all six digits
 * are in.
 */

import { useState } from "react";

export interface SearchHit {
  label: string;
  latitude: number;
  longitude: number;
  kind: "station" | "place";
}

export default function PlaceSearch({
  near,
  onPick,
}: {
  /** The city's centre, to rank nearby answers first. */
  near: { latitude: number; longitude: number } | null;
  onPick: (hit: SearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    const query = q.trim();
    if (query.length < 3) {
      setError("Type at least three letters, or your six-digit PIN code.");
      return;
    }
    setBusy(true);
    setError(null);
    setHits(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (near) {
        params.set("lat", String(near.latitude));
        params.set("lng", String(near.longitude));
      }
      const res = await fetch(`/api/geocode?${params}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not search just now.");
        return;
      }
      const found: SearchHit[] = Array.isArray(body.data) ? body.data : [];
      setHits(found);
      if (!found.length) {
        setError("Nothing found. Try a bigger landmark nearby, or tap the map instead.");
      }
    } catch {
      setError("Could not reach the server. You can still tap the map.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* HIDDEN, NOT DELETED. On screen it was a second question stacked on
          the city question above it; Amrita asked for it gone. A screen reader
          still needs a name for the box, so the label stays for those alone. */}
      <label htmlFor="place-search" className="sr-only">
        Search for your area or PIN code
      </label>
      <p className="text-sm text-gray-600">
        Type your area or your PIN code — or tap the map below.
      </p>

      <div className="mt-2 flex gap-2">
        <input
          id="place-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
          // inputMode text rather than numeric: a PIN code is the minority
          // case and forcing a number pad would make names hard to type.
          placeholder="e.g. Bandra East, or 400051"
          autoComplete="off"
          className="min-h-[2.75rem] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base outline-none focus:border-gray-500"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={busy}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? "…" : "Search"}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-amber-800">{error}</p>}

      {hits && hits.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {hits.map((h) => (
            <li key={`${h.latitude},${h.longitude}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  // The list has done its job; leaving it open would compete
                  // with the map it just moved.
                  setHits(null);
                  setQ(h.label);
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-gray-50"
              >
                <span className="min-w-0 text-sm">{h.label}</span>
                {/* Worth saying: a station is where a real instrument is, and
                    picking one means the forecast is built from measurements
                    taken where you are rather than averaged towards you. */}
                {h.kind === "station" && (
                  <span className="shrink-0 text-xs text-gray-500">monitoring station</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
