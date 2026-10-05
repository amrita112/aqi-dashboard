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

type Step = "location" | "measurement" | "threshold";

export default function SetupFlow() {
  const router = useRouter();
  const [cities, setCities] = useState<City[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("location");
  const [cityName, setCityName] = useState<string | null>(null);
  const [station, setStation] = useState<Station | null>(null);
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

  function finish() {
    if (!city || !station) return;
    savePrefs({
      city: city.city,
      anchor: {
        monitor_id: station.monitor_id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
      },
      measurement,
      threshold: notify ? threshold : null,
    });
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
      <StepDots step={step} />

      {step === "location" && (
        <section>
          <h2 className="text-xl font-semibold">Where do you want air quality for?</h2>
          <p className="mt-1 text-sm text-gray-600">
            Pick anywhere we cover — it does not have to be where you are now.
          </p>

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
                  setStation(null);
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

            {city && (
              <div>
                <label htmlFor="station" className="block text-sm font-medium text-gray-700">
                  Which part of {city.city}?
                </label>
                <select
                  id="station"
                  value={station?.monitor_id ?? ""}
                  onChange={(e) =>
                    setStation(city.stations.find((s) => s.monitor_id === e.target.value) ?? null)
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
                >
                  <option value="">Choose an area…</option>
                  {city.stations.map((s) => (
                    <option key={s.monitor_id} value={s.monitor_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Pick whichever is nearest you. We average the few closest monitoring
                  stations around it rather than relying on any single one.
                </p>
              </div>
            )}
          </div>

          <Next disabled={!station} onClick={() => setStep("measurement")} />
        </section>
      )}

      {step === "measurement" && (
        <section>
          <h2 className="text-xl font-semibold">Which number would you rather see?</h2>
          <p className="mt-1 text-sm text-gray-600">
            Both are shown everywhere in the app. This just picks the one that leads.
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
            Neither is wrong — they answer different questions. You can change this later.
          </p>

          <Next onClick={() => setStep("threshold")} onBack={() => setStep("location")} />
        </section>
      )}

      {step === "threshold" && (
        <section>
          <h2 className="text-xl font-semibold">When should we tell you?</h2>
          <p className="mt-1 text-sm text-gray-600">
            We can flag the days when tomorrow&apos;s air is forecast to be worse than a level
            you choose.
          </p>

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
              <span className="block font-medium">Tell me on bad days</span>
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
                    <p className="mt-2 text-xs text-gray-600">
                      {threshold === suggested ? "This is the " : "Suggested: "}
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
                      — a typical bad day in {city?.city} between October and February. Keep it
                      and you will hear from us on roughly half the days of the season.
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
              <span className="mt-1 block text-sm text-gray-600">
                I will check the app when I want to know.
              </span>
            </button>
          </div>

          {/* Said now rather than discovered later. */}
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Notifications are not switched on yet — this saves your preference so they work
            the day they are. Everything else in the app works now.
          </p>

          <Next
            label="Finish"
            disabled={notify && (threshold === null || threshold < 1)}
            onClick={finish}
            onBack={() => setStep("measurement")}
          />
        </section>
      )}

      <p className="mt-8 text-xs text-gray-500">
        These three answers are kept on this device only — no account, nothing sent to us.
        Clearing your browser data will lose them.
      </p>
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
