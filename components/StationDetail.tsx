"use client";

/**
 * The card that opens when a station on the map is tapped.
 *
 * REPLACES A LABEL WITH A SERIES. The old popup showed the last reading, the
 * pollutant driving it, and the distance from the user — three facts, none of
 * which answer "so what is this place like". A station is a time series, and
 * three views of it are worth more than any single number:
 *
 *   7-day forecast    the days ahead, hour by hour
 *   Next 24 hours     today's shape, which is what people act on
 *   Past month        what actually happened, which is the only measured one
 *
 * The distance and the driving pollutant are gone. Distance belongs to the
 * setup screen, where it decides something; "driven by PM10" is interesting
 * once and clutter forever after.
 */

import { useEffect, useState } from "react";
import ForecastChart, { type ForecastDayInput } from "@/components/ForecastChart";
import HistoryChart from "@/components/HistoryChart";
import { MEASUREMENT_COPY, type Measurement } from "@/lib/prefs";

export type DetailRange = "forecast7" | "next24" | "past30";

const RANGE_LABEL: Record<DetailRange, string> = {
  forecast7: "7-day forecast",
  next24: "Next 24 hours",
  past30: "Past month",
};

interface Day {
  target_date: string;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  hourly: { hour: number; value: number; band_low: number | null; band_high: number | null }[] | null;
}

export interface DetailStation {
  monitor_id: string;
  name: string;
  city: string | null;
  date: string | null;
  age_days: number | null;
}

/** "Bandra Kurla Complex, Mumbai - MPCB" -> "MPCB". */
function networkOf(name: string): string | null {
  const tail = name.split("-").pop()?.trim();
  return tail && tail.length <= 8 ? tail : null;
}

function cleanestLine(
  hours: { hour: number; value: number }[] | null,
  unit: string,
): string | null {
  if (!hours?.length) return null;
  const day = hours.filter((h) => h.hour >= 6 && h.hour <= 21);
  if (day.length < 4) return null;
  let best = day[0];
  let worst = day[0];
  for (const h of day) {
    if (h.value < best.value) best = h;
    if (h.value > worst.value) worst = h;
  }
  const fmt = (h: number) => {
    const s = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${s}`;
  };
  return `Cleanest around ${fmt(best.hour)} · worst around ${fmt(worst.hour)}${
    unit ? ` (${unit})` : ""
  }`;
}

export default function StationDetail({
  station,
  measurement,
  onClose,
}: {
  station: DetailStation;
  measurement: Measurement;
  onClose: () => void;
}) {
  const [range, setRange] = useState<DetailRange>("forecast7");
  const [days, setDays] = useState<Day[] | null>(null);
  const [history, setHistory] = useState<{ date: string; value: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unit = MEASUREMENT_COPY[measurement].unit;
  const short = MEASUREMENT_COPY[measurement].short;

  useEffect(() => {
    let cancelled = false;
    setError(null);

    if (range === "past30") {
      setHistory(null);
      fetch(
        `/api/history?monitor_id=${station.monitor_id}&pollutant=${measurement}&days=30`,
      )
        .then((r) => r.json())
        .then((b) => {
          if (cancelled) return;
          if (b?.error) return setError(b.error.message);
          // /api/history returns `data` as a plain array of daily rows.
          setHistory(
            (Array.isArray(b.data) ? b.data : [])
              .filter((d: { mean: number | null }) => d.mean !== null)
              .map((d: { date: string; mean: number }) => ({ date: d.date, value: d.mean })),
          );
        })
        .catch(() => !cancelled && setError("Could not reach the server."));
      return () => {
        cancelled = true;
      };
    }

    setDays(null);
    const wanted = range === "next24" ? 1 : 7;
    fetch(
      `/api/forecast?monitor_id=${station.monitor_id}&pollutant=${measurement}` +
        `&days=${wanted}&hourly=true&include_today=true`,
    )
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return;
        if (b?.error) return setError(b.error.message);
        setDays(b.data?.days ?? []);
      })
      .catch(() => !cancelled && setError("Could not reach the server."));
    return () => {
      cancelled = true;
    };
  }, [range, station.monitor_id, measurement]);

  const points: ForecastDayInput[] = (days ?? []).map((d, i) => ({
    target_date: d.target_date,
    value: d.value,
    band_low: d.band_low,
    band_high: d.band_high,
    mode: d.mode,
    hourly: d.hourly,
    label:
      i === 0
        ? "Today"
        : new Date(`${d.target_date}T12:00:00+05:30`).toLocaleDateString("en-IN", {
            weekday: "short",
          }),
  }));

  const hoursLine = cleanestLine(days?.[0]?.hourly ?? null, unit);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{station.name.split(",")[0]}</p>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {[station.city, networkOf(station.name)].filter(Boolean).join(" · ")}
            {station.age_days !== null &&
              ` · measured ${station.age_days === 0 ? "today" : `${station.age_days} d ago`}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as DetailRange)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
            aria-label="What to show"
          >
            {(Object.keys(RANGE_LABEL) as DetailRange[]).map((k) => (
              <option key={k} value={k}>
                {RANGE_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
          >
            ×
          </button>
        </div>
      </div>

      <div className="mt-3">
        {error && <p className="py-6 text-center text-sm text-red-700">{error}</p>}
        {!error && range === "past30" && (
          history === null ? (
            <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
          ) : history.length < 2 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              Nothing measured here in the last month.
            </p>
          ) : (
            <HistoryChart points={history} unit={unit} label={short} />
          )
        )}
        {!error && range !== "past30" && (
          days === null ? (
            <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
          ) : points.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              No forecast stored for this station.
            </p>
          ) : (
            <ForecastChart days={points} unit={unit} />
          )
        )}
      </div>

      {range !== "past30" && hoursLine && (
        <p className="mt-2 text-sm text-gray-700">{hoursLine}</p>
      )}
    </div>
  );
}
