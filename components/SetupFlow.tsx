"use client";

/**
 * First run, in two questions.
 *
 * Two, because every question costs people who have not yet seen the app do
 * anything useful. Where you are, and which number you want. There was a
 * third — a notification threshold — and it went: it asked people to pick a
 * level for alerts the app cannot send yet, which reads as either a broken
 * promise or a trick question. It returns with the notifications.
 *
 * A client component throughout: it is a form with steps, and nothing here is
 * worth rendering on the server. The station list arrives from /api/locations
 * in one call, with each city's prefilled alert threshold attached, so moving
 * between steps never waits on the network.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import CityRequestForm from "@/components/CityRequestForm";
import InstallHint from "@/components/InstallHint";
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

type Step = "location" | "measurement";

export default function SetupFlow() {
  const router = useRouter();
  const [cities, setCities] = useState<City[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("location");
  const [cityName, setCityName] = useState<string | null>(null);
  const [place, setPlace] = useState<import("@/components/LocationPicker").PickedPlace | null>(null);
  // PM2.5 LEADS. It is the fraction with the worst long-term health effects,
  // and the one a person can act on — AQI is the familiar number but is driven
  // by coarse dust most of the time in these cities. Someone who does not have
  // a view should get the one worth having.
  const [measurement, setMeasurement] = useState<Measurement>("pm25");

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
      // NO THRESHOLD IS ASKED FOR ANY MORE. It was the third setup question,
      // and it asked people to choose a notification level for notifications
      // that do not exist yet — which a tester found simply confusing, and he
      // was right: a preference saved for a feature nobody can use is a
      // question that costs attention and returns nothing. It comes back with
      // the notifications, where it will mean something.
      threshold: null,
    });
    // Home, not Ask. Reversed after the 12 Oct review: the first thing someone
    // wants after telling the app where they are is to see the number for that
    // place, not a blank question box.
    router.push("/");
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
      {/* BEFORE THE QUESTIONS, not after them. A tester who had been told he
          was getting an app answered three questions in a browser first and
          only then met a button offering to save it to his home screen — by
          which point he had decided this was a website.
          Only on the first step: a banner that follows someone through a
          three-question flow is nagging, and on iOS it matters most here
          anyway, because Safari and a home-screen app do NOT share storage.
          Answers given in the browser are not carried into the installed app,
          so installing first means doing this once rather than twice. */}
      {step === "location" && (
        <div className="mb-5">
          <InstallHint />
        </div>
      )}

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

          {/* Offered here because this is the screen where someone discovers
              we do not cover them, and the worst moment to have nothing to say. */}
          <div className="mt-4">
            <CityRequestForm />
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
            You can change this later.
          </p>

          <Next onClick={finish} onBack={() => setStep("location")} label="Finish" />
        </section>
      )}

    </div>
  );
}

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["location", "measurement"];
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
