"use client";

/**
 * First run, in three questions.
 *
 * Three, and not four, because every extra question costs people who have not
 * yet seen the app do anything useful. Location, which number they want, and
 * when to be told. Everything else has a sensible default or can wait for the
 * settings screen.
 *
 * A client component throughout: it is a form with steps, and nothing here is
 * worth rendering on the server. The station list arrives from /api/locations
 * in one call, with each city's prefilled alert threshold attached, so moving
 * between steps never waits on the network.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  savePrefs,
  MEASUREMENT_COPY,
  type Measurement,
} from "@/lib/prefs";

interface Station {
  monitor_id: string;
  name: string;
  latitude: number;
  longitude: number;
}

interface City {
  city: string;
  station_count: number;
  stations: Station[];
  alert_default: {
    aqi?: { threshold: number; source: string };
    pm25?: { threshold: number; source: string };
  } | null;
}

// Leaflet reaches for `window` at import time, so the picker can never be part
// of a server render. Same pattern the map screen already uses.
const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => (
    <div className="h-64 w-full animate-pulse rounded-md border border-gray-300 bg-gray-100" />
  ),
});

type Step = "location" | "measurement" | "threshold";

export default function SetupFlow() {
  const router = useRouter();
  const [cities, setCities] = useState<City[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("location");
  const [cityName, setCityName] = useState<string | null>(null);
  const [place, setPlace] = useState<import("@/components/LocationPicker").PickedPlace | null>(null);
  const [measurement, setMeasurement] = useState<Measurement>("aqi");
  const [notify, setNotify] = useState(true);
  const [threshold, setThreshold] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/locations")
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.error) setLoadError(body.error.message);
        else setCities(body.data as City[]);
      })
      .catch(() => !cancelled && setLoadError("Could not load the list of places."));
    return () => {
      cancelled = true;
    };
  }, []);

  const city = useMemo(
    () => cities?.find((c) => c.city === cityName) ?? null,
    [cities, cityName],
  );

  // The default moves with the measurement, because an AQI threshold of 380
  // would be nonsense as a PM2.5 one.
  const suggested = city?.alert_default?.[measurement]?.threshold ?? null;
  useEffect(() => {
    if (suggested !== null) setThreshold(suggested);
  }, [suggested]);

  // The map needs somewhere to open. The mean of a city's own stations is a
  // better centre than a hardcoded coordinate per city, and it cannot go stale
  // when the station list changes.
  const centre = useMemo(() => {
    if (!city?.stations?.length) return null;
    const n = city.stations.length;
    return {
      latitude: city.stations.reduce((t, x) => t + x.latitude, 0) / n,
      longitude: city.stations.reduce((t, x) => t + x.longitude, 0) / n,
    };
  }, [city]);

  function finish() {
    if (!city || !place) return;
    savePrefs({
      city: city.city,
      anchor: {
        // The nearest station at the time of choosing, kept for callers that
        // want one representative site. The place itself is what the app shows.
        monitor_id: place.stations[0]?.monitor_id ?? "",
        name: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      measurement,
      threshold: notify ? threshold : null,
    });
    // Land on the Ask tab, not Home. The first thing someone wants after
    // answering three questions is to try the thing the app is for, and the
    // old behaviour flashed Ask and then replaced it with Home, which looked
    // like a bug.
    router.push("/ask");
  }

  if (loadError) {
    return (
      <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
        {loadError} Please reload the page.
      </p>
    );
  }
  if (!cities) {
    return <p className="text-gray-500">Loading places…</p>;
  }

  return (
    <div>
      <StepDots step={step} />

      {step === "location" && (
        <section>
          <h2 className="text-xl font-semibold">Which city&apos;s air quality do you want to see?</h2>

          <div className="mt-5 space-y-5">
            <div>
              <label htmlFor="city" className="block text-sm font-medium text-gray-700">
                City
              </label>
              <select
                id="city"
                value={cityName ?? ""}
                onChange={(e) => {
                  setCityName(e.target.value || null);
                  setPlace(null);
                }}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
              >
                <option value="">Choose a city…</option>
                {cities.map((c) => (
                  <option key={c.city} value={c.city}>
                    {c.city} ({c.station_count} stations)
                  </option>
                ))}
              </select>
            </div>

            {city && centre && (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Where in {city.city}?
                </label>
                <div className="mt-1">
                  <LocationPicker
                    centre={centre}
                    city={city.city}
                    value={place}
                    onChange={setPlace}
                  />
                </div>
              </div>
            )}
          </div>

          <Next disabled={!place} onClick={() => setStep("measurement")} />
        </section>
      )}

      {step === "measurement" && (
        <section>
          <h2 className="text-xl font-semibold">Do you want to see AQI or just PM2.5 levels?</h2>
          <p className="mt-1 hidden text-sm text-gray-600">
          </p>

          <div className="mt-5 space-y-3">
            {(Object.keys(MEASUREMENT_COPY) as Measurement[]).map((key) => {
              const copy = MEASUREMENT_COPY[key];
              const selected = measurement === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMeasurement(key)}
                  className={`w-full rounded-lg border p-4 text-left ${
                    selected
                      ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                      : "border-gray-300 bg-white hover:bg-gray-50"
                  }`}
                >
                  <span className="block font-medium">
                    {copy.label}
                    {copy.unit && (
                      <span className="ml-1 font-normal text-gray-500">({copy.unit})</span>
                    )}
                  </span>
                  <span className="mt-1 block text-sm text-gray-600">{copy.blurb}</span>
                </button>
              );
            })}
          </div>

          <p className="mt-4 text-xs text-gray-500">
            You can change this later.{" "}
            {/* A NEW TAB, so the half-finished setup survives. Following the
                link in place lost the city and the pin -- there is nowhere to
                put in-progress answers, since prefs are only written at the
                end, so the fix is not to navigate away at all. */}
            <Link
              href="/learn/aqi-vs-pm25"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Click here to learn more
            </Link>
            .
          </p>

          <Next onClick={() => setStep("threshold")} onBack={() => setStep("location")} />
        </section>
      )}

      {step === "threshold" && (
        <section>
          <h2 className="text-xl font-semibold">
            Would you like to be notified when {MEASUREMENT_COPY[measurement].short} crosses a
            particular threshold?
          </h2>

          <div className="mt-5 space-y-3">
            <button
              type="button"
              onClick={() => setNotify(true)}
              className={`w-full rounded-lg border p-4 text-left ${
                notify
                  ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                  : "border-gray-300 bg-white hover:bg-gray-50"
              }`}
            >
              <span className="block font-medium">
                Yes, tell me when {MEASUREMENT_COPY[measurement].short} is{" "}
                {notify ? "" : (threshold ?? suggested ?? "")} or above
              </span>
              {notify && (
                <div className="mt-3">
                  <div className="flex items-baseline gap-2">
                    <input
                      type="number"
                      min={1}
                      max={measurement === "aqi" ? 500 : 500}
                      value={threshold ?? ""}
                      onChange={(e) =>
                        setThreshold(e.target.value === "" ? null : Number(e.target.value))
                      }
                      onClick={(e) => e.stopPropagation()}
                      className="w-28 rounded-md border border-gray-300 px-3 py-2"
                    />
                    <span className="text-sm text-gray-600">
                      {MEASUREMENT_COPY[measurement].short}
                      {MEASUREMENT_COPY[measurement].unit &&
                        ` ${MEASUREMENT_COPY[measurement].unit}`}{" "}
                      or above
                    </span>
                  </div>
                  {suggested !== null && (
                    /* One sentence regardless of whether the box still holds the
                       suggestion. The old copy switched between "This is the X"
                       and "Suggested: X", which read as two different facts
                       about the same number. */
                    <p className="mt-2 text-xs text-gray-600">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setThreshold(suggested);
                        }}
                        className="font-medium underline"
                      >
                        {suggested}
                      </button>{" "}
                      is the median value of {MEASUREMENT_COPY[measurement].short} in{" "}
                      {city?.city} between October and February. With this threshold, you will
                      get a notification on roughly half the days this season.
                    </p>
                  )}
                </div>
              )}
            </button>

            <button
              type="button"
              onClick={() => setNotify(false)}
              className={`w-full rounded-lg border p-4 text-left ${
                !notify
                  ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                  : "border-gray-300 bg-white hover:bg-gray-50"
              }`}
            >
              <span className="block font-medium">Do not notify me</span>
            </button>
          </div>

          {/* Said now rather than discovered later. */}
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Note: notifications are not enabled in the beta version of the app. This saves
            your preferences, so that they are in place when we update the app to send
            notifications.
          </p>

          <Next
            label="Finish"
            disabled={notify && (threshold === null || threshold < 1)}
            onClick={finish}
            onBack={() => setStep("measurement")}
          />
        </section>
      )}
    </div>
  );
}

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["location", "measurement", "threshold"];
  const index = order.indexOf(step);
  return (
    <div className="mb-6 flex items-center gap-2" aria-label={`Step ${index + 1} of 3`}>
      {order.map((s, i) => (
        <span
          key={s}
          className={`h-1.5 flex-1 rounded-full ${i <= index ? "bg-blue-600" : "bg-gray-200"}`}
        />
      ))}
    </div>
  );
}

function Next({
  onClick,
  onBack,
  disabled,
  label = "Continue",
}: {
  onClick: () => void;
  onBack?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="mt-6 flex items-center gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-gray-300 px-4 py-2.5 text-sm hover:bg-gray-50"
        >
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex-1 rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {label}
      </button>
    </div>
  );
}
