"use client";

/**
 * The two answers from first run, each editable on its own.
 *
 * EVERY CHANGE SAVES IMMEDIATELY. There is no Save button and no draft state:
 * each control writes to localStorage as it is used, the way a phone's own
 * settings behave. A Save button would invite someone to change two things,
 * miss the button, and lose both.
 *
 * The location editor is the setup map, reused rather than reimplemented, so
 * the two can never drift into showing different stations for the same point.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  clearPrefs,
  loadPrefs,
  savePrefs,
  MEASUREMENT_COPY,
  NEAREST_K,
  type Measurement,
  type Prefs,
} from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import CityRequestForm from "@/components/CityRequestForm";
import FeedbackLink from "@/components/FeedbackLink";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => <div className="h-64 w-full animate-pulse rounded-md bg-gray-100" />,
});

interface City {
  city: string;
  station_count: number;
  alert_default?: Record<string, { threshold: number } | undefined>;
  stations: { monitor_id: string; name: string; latitude: number; longitude: number }[];
}

export default function SettingsScreen() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [cities, setCities] = useState<City[] | null>(null);
  const [editing, setEditing] = useState<null | "place">(null);
  const [cityName, setCityName] = useState<string | null>(null);
  const [picked, setPicked] = useState<import("@/components/LocationPicker").PickedPlace | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setCityName(p?.city ?? null);
    fetch("/api/locations")
      .then((r) => r.json())
      .then((b) => setCities(b.data ?? []))
      .catch(() => setCities([]));
  }, []);

  const city = useMemo(
    () => cities?.find((c) => c.city === cityName) ?? null,
    [cities, cityName],
  );

  const centre = useMemo(() => {
    if (!city?.stations?.length) return null;
    const n = city.stations.length;
    return {
      latitude: city.stations.reduce((t, s) => t + s.latitude, 0) / n,
      longitude: city.stations.reduce((t, s) => t + s.longitude, 0) / n,
    };
  }, [city]);

  /** Write one field and confirm it, so a change never looks like it was lost. */
  function update(patch: Partial<Omit<Prefs, "version" | "saved_at">>, note: string) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    savePrefs({
      city: next.city,
      anchor: next.anchor,
      measurement: next.measurement,
      threshold: next.threshold,
    });
    setPrefs(loadPrefs());
    setSaved(note);
    window.setTimeout(() => setSaved(null), 2000);
  }

  if (!prefs) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-4 text-gray-600">
          Nothing is set up yet.{" "}
          <Link href="/setup" className="text-blue-700 underline">
            Answer two questions
          </Link>{" "}
          and {APP_NAME} will know what to show you.
        </p>
      </div>
    );
  }


  return (
    <div className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
      {/* A WAY BACK. Settings is reached by tapping "Change" beside the
          location on the home screen, and a tester who did that could not tell
          he had been taken to Settings at all, let alone how to leave. The tab
          bar is the answer, but only once you have noticed the tab bar — and
          he had not. An explicit Done costs one line and removes the trap. */}
      <div className="flex items-center justify-between gap-3 lg:col-span-2">
        <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>
        <Link
          href="/"
          className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800"
        >
          Return to Home
        </Link>
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 lg:col-span-2">
        Settings
      </h2>

      {saved && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900 lg:col-span-2">
          {saved}
        </p>
      )}

      {/* ── Location ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Location
            </h2>
            <p className="mt-1 font-medium">{prefs.anchor.name}</p>
            <p className="text-sm text-gray-600">
              {prefs.city} · averaged over the {NEAREST_K} nearest stations
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(editing === "place" ? null : "place");
              setPicked(null);
            }}
            className="shrink-0 text-sm font-medium text-blue-700 underline"
          >
            {editing === "place" ? "Cancel" : "Change"}
          </button>
        </div>

        {editing === "place" && (
          <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
            <label htmlFor="city" className="block text-sm font-medium text-gray-700">
              City
            </label>
            <select
              id="city"
              value={cityName ?? ""}
              onChange={(e) => {
                setCityName(e.target.value || null);
                setPicked(null);
              }}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            >
              {/* disabled, so it reads as a prompt rather than an option
                  that clears the city you already have. */}
              <option value="" disabled>
                Choose a city…
              </option>
              {(cities ?? []).map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city} ({c.station_count} stations)
                </option>
              ))}
            </select>

            {city && centre && (
              <LocationPicker
                /* KEYED ON THE CITY so a change starts a clean picker. The
                   component keeps the dropped pin and the three nearest
                   stations in its own state, seeded once from `value`; without
                   this, choosing a different city left the previous city's pin
                   and station list sitting on the new map. */
                key={city.city}
                centre={centre}
                city={city.city}
                value={picked}
                onChange={setPicked}
              />
            )}

            <button
              type="button"
              disabled={!picked || !city}
              onClick={() => {
                if (!picked || !city) return;
                update(
                  {
                    city: city.city,
                    anchor: {
                      monitor_id: picked.stations[0]?.monitor_id ?? "",
                      name: picked.label,
                      latitude: picked.latitude,
                      longitude: picked.longitude,
                    },
                  },
                  "Location saved.",
                );
                setEditing(null);
              }}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
            >
              Save this place
            </button>
          </div>
        )}
      </section>

      {/* ── Pollutant ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Preferred measure
        </h2>
        <div className="mt-3 space-y-2">
          {(Object.keys(MEASUREMENT_COPY) as Measurement[]).map((key) => {
            const copy = MEASUREMENT_COPY[key];
            const on = prefs.measurement === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => update({ measurement: key }, `Now showing ${copy.short}.`)}
                className={`w-full rounded-lg border p-3 text-left ${
                  on ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600" : "border-gray-300"
                }`}
              >
                <span className="block font-medium">{copy.label}</span>
                <span className="mt-1 block text-sm text-gray-600">{copy.blurb}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* NO THRESHOLD CARD. It set a level for notifications that do not
          exist yet — a preference for a feature nobody can use, which a
          tester found confusing rather than reassuring. The setup question
          behind it has gone too. Both return with the notifications. */}

      {/* Its own card, not a bullet buried in a list: Amrita looked for this
          and could not find it. */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Your city not listed?
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          Send us a message saying you would like your location added, and ask your friends
          and family to do the same. If we get 50 requests for any location in India, we will
          add it.
        </p>
        <div className="mt-3">
          <CityRequestForm />
        </div>
      </section>

      {/* Its own card, like the city request above it, so it can be found
          by someone who came here looking for it. */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Feedback
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          Something wrong, confusing, or missing? Tell us. It opens a short Google Form.
        </p>
        <div className="mt-3">
          <FeedbackLink />
        </div>
      </section>

      {/* ── Beyond the two answers ────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          About the data
        </h2>
        {/* CITED, because both sources ask to be and because the app's whole
            argument is that its numbers are someone else's measurements rather
            than our estimates. Saying they mostly carry the same CPCB data
            matters too: otherwise two names look like two independent
            confirmations of a reading. */}
        <p className="mt-2 text-sm text-gray-700">
          Readings come from India&apos;s Central Pollution Control Board (CPCB) monitors.
          Recent readings are downloaded from{" "}
          <a
            href="https://openaq.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            OpenAQ
          </a>
          , and the historical data, which is used to make forecasts, is taken from XKDR
          Forum&apos;s India Air Quality Database. Note that these are not independent sources,
          as they both get their data from the same CPCB monitors.
        </p>

        {/* XKDR'S OWN CITATION FORMAT, verbatim, because that is what they ask
            for: the database cited and both of its sources credited. It is set
            apart rather than woven into the prose above so it can be copied as
            a citation — someone writing this up should not have to reassemble
            it from a sentence. */}
        <div className="mt-3 border-l-2 border-gray-200 pl-3 text-xs text-gray-600">
          <p>
            XKDR Forum (2026). India Air Quality Database.{" "}
            <a
              href="https://airquality.xkdr.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              https://airquality.xkdr.org
            </a>
          </p>
          <p className="mt-1">
            Sources: Central Pollution Control Board (CPCB), Continuous Ambient Air Quality
            Monitoring network; US Department of State air quality monitors, via AirNow.
          </p>
        </div>
        <ul className="mt-3 space-y-3 text-sm">
          <li>
            {/* THE PETITION HAD NO LINK LEFT. It used to sit in the data-age box
                on the home screen, which the 7 Oct review removed — so the page
                existed with nothing pointing at it. */}
            <Link href="/petition" className="font-medium text-blue-700 underline">
              Support hyperlocal measurement
            </Link>
            {/* The 2–4 km / 30–60% figures are from section 5 of
                notebooks/substack_figures.ipynb: every pair of Delhi monitors,
                winter PM2.5, winters 2019-20 onwards. */}
            <p className="mt-1 text-gray-600">
              We average the readings from the three CPCB monitors nearest to you, but in most
              cases, those monitors are too far away to give accurate readings for your
              particular location. For example, in Delhi, monitors that are 2–4 km apart differ
              by 30–60% in winter PM2.5. Further, the data we are able to obtain from OpenAQ is
              often 1–4 days old. So to improve air quality forecasting, we need much more dense,
              frequently updated air quality measurements in every city. If you would like to
              help us raise funds to obtain dense air quality data for more accurate predictions,
              add your name to{" "}
              <Link href="/petition" className="text-blue-700 underline">
                this petition
              </Link>
              .
            </p>
          </li>

        </ul>
      </section>

      <section className="px-1 lg:col-span-2">
        <button
          type="button"
          onClick={() => {
            // Confirmed, because there is no account and nothing to restore it
            // from: this is the one irreversible button in the app.
            if (!window.confirm("Forget your place and your measure on this device?")) return;
            clearPrefs();
            window.location.href = "/setup";
          }}
          className="text-sm text-red-700 underline"
        >
          Reset everything
        </button>
        <p className="mt-1 text-xs text-gray-500">
          Your answers are kept on this device only. Clearing your browser data loses them.
        </p>
        {/* REACHABLE FROM INSIDE THE APP. Someone who installed this to a home
            screen has no address bar and no repository; a privacy page they
            cannot open is a document written for somebody else. */}
        <p className="mt-4 text-xs text-gray-500">
          <Link href="/privacy" className="underline">
            Privacy
          </Link>
          {" · "}
          <Link href="/terms" className="underline">
            Terms of use
          </Link>
        </p>
      </section>
    </div>
  );
}
