"use client";

/**
 * Historical trends: the yearly pattern of one station or place, month by month.
 *
 * Shared by the Map tab's station card (StationDetail) and the Trends tab
 * (TrendsScreen), so both draw the same thing the same way. This component
 * fetches its own data from /api/climate -- the caller only says which
 * station or place, and in which measure.
 *
 * A CLIENT COMPONENT, not a server one: it reacts to the finger (the reading
 * under it) and to the "Each year" toggle, and both cards it sits in are
 * client components already.
 *
 * WHAT IS DRAWN
 *   black line   the average day: each month's average daily mean, the
 *                median year (unusual station-years screened out first;
 *                lib/api/climate.ts)
 *   grey band    the average daily low to the average daily high
 *   grey dots    months with too few years behind them to call typical
 *                (lib/api/climate.ts, DEFAULT_MIN_YEARS); no band there
 *   faint lines  optional: one per year, the latest in blue, so a person can
 *                see whether this year is unusual. Screened-out station-years
 *                are omitted from these too; the footnote counts them.
 *
 * Twelve months on the x-axis, January first. Single letters, because twelve
 * three-letter names do not fit a phone's width; the readout names the month.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Label,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SCREEN_FACTOR, type ClimateResult } from "@/lib/api/climate";
import { hoveredIndex } from "@/lib/chart-hover";
import { tightScale } from "@/lib/chart-scale";
import BandStrip, { axisLabelOfUnit, BAND_LINE, BAND_LINE_Z, bandBoundaries, measurementOfUnit } from "@/components/BandStrip";
import { MEASUREMENT_COPY, type Measurement } from "@/lib/prefs";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Plot margins, shared with the band strip so its ends meet the plot's. */
const TOP_MARGIN = 8;
const X_AXIS_HEIGHT = 24;

/** Colours: the same black and blue the other charts use for "this place". */
const MEAN_COLOUR = "#12171b";
const BAND_COLOUR = "#5c6b73";
const SPARSE_COLOUR = "#9aa5ab";
const YEAR_COLOUR = "#9aa5ab";
const LATEST_YEAR_COLOUR = "#2a78d6";

type Row = Record<string, number | string | null | [number, number]>;

export default function ClimateChart({
  query,
  measurement,
  stationWord = "monitoring station",
  height = 192,
}: {
  /**
   * Which station or place: the same query the other charts send, e.g.
   * { monitor_id } or { lat, lng, k, max_km?, city? }.
   */
  query: Record<string, string>;
  measurement: Measurement;
  /**
   * How the empty message names what was asked about, e.g. "monitoring
   * station" or "monitoring stations near this place".
   */
  stationWord?: string;
  height?: number;
}) {
  const [data, setData] = useState<ClimateResult | null>(null);
  const [stationsUsed, setStationsUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showYears, setShowYears] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const unit = MEASUREMENT_COPY[measurement].unit;

  // Stable dependency: the query object is rebuilt on every render upstream.
  const qs = useMemo(
    () => new URLSearchParams({ ...query, metric: measurement }).toString(),
    [query, measurement],
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setHover(null);
    (async () => {
      try {
        const r = await fetch(`/api/climate?${qs}`);
        const b = await r.json();
        if (cancelled) return;
        if (b?.error) return setError(b.error.message);
        setData(b.data as ClimateResult);
        setStationsUsed(Number(b.meta?.stations_used ?? 0));
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qs]);

  if (error) return <p className="py-6 text-center text-sm text-red-700">{error}</p>;
  if (data === null) return <p className="py-10 text-center text-sm text-gray-500">Loading…</p>;
  if (data.n_years === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-500">
        No complete months on record for this {stationWord} yet.
      </p>
    );
  }

  const latest = data.last_year;
  const yearsShown = showYears ? data.years : [];

  // One row per month. The mean and band only where enough years stand
  // behind it; otherwise the month's value is a grey dot and no band.
  const rows: Row[] = data.months.map((m, i) => {
    const row: Row = {
      i,
      label: MONTH_NAMES[i][0],
      mean: m.enough_years ? m.mean : null,
      sparse: !m.enough_years ? m.mean : null,
      band: m.enough_years && m.min !== null && m.max !== null ? [m.min, m.max] : null,
    };
    for (const y of yearsShown) row[`y${y.year}`] = y.months[i].mean;
    return row;
  });

  const values = [
    ...data.months.flatMap((m) => [m.mean, m.min, m.max]),
    ...yearsShown.flatMap((y) => y.months.map((m) => m.mean)),
  ].filter((v): v is number => typeof v === "number");
  const scale = tightScale(Math.min(...values), Math.max(...values));

  const report = (state: { activeTooltipIndex?: number | string | null } | undefined) =>
    setHover(hoveredIndex(state, rows.length));

  const hovered = hover === null ? null : data.months[hover];
  const hoveredLatest =
    hover !== null && latest !== null
      ? data.years.find((y) => y.year === latest)?.months[hover].mean ?? null
      : null;
  const fmt = (v: number | null) => (v === null ? "–" : String(Math.round(v)));
  const hasSparse = data.months.some((m) => !m.enough_years && m.mean !== null);
  const isAqi = measurement === "aqi";

  return (
    <div className="w-full">
      {/* How much history stands behind the chart, said first. */}
      <p className="text-xs text-gray-600">
        {data.n_years} {data.n_years === 1 ? "year" : "years"} ({data.first_year}
        {data.last_year !== data.first_year ? `–${data.last_year}` : ""})
        {stationsUsed > 1 ? ` · ${stationsUsed} stations` : ""}
      </p>

      {/* The reading under the finger. Height reserved so the chart does not
          jump as a finger moves. */}
      <p className="mt-0.5 min-h-[1.25rem] text-xs font-medium text-gray-900">
        {hovered && hovered.mean !== null && (
          <>
            {MONTH_NAMES[hovered.month - 1]}: {fmt(hovered.mean)}
            <span className="font-normal text-gray-600">
              {" "}
              (low {fmt(hovered.min)}, high {fmt(hovered.max)}){unit ? ` ${unit}` : ""} ·{" "}
              {hovered.n_years} {hovered.n_years === 1 ? "year" : "years"}
            </span>
            {showYears && hoveredLatest !== null && (
              <span style={{ color: LATEST_YEAR_COLOUR }}> · {latest}: {fmt(hoveredLatest)}</span>
            )}
          </>
        )}
      </p>

      <div style={{ height }} className="flex w-full gap-1.5">
        <div className="h-full min-w-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows}
              margin={{ top: TOP_MARGIN, right: 4, left: 0, bottom: 0 }}
              // Mouse AND touch, as on the other charts: recharts fires
              // onMouseMove only for a mouse.
              onMouseMove={report}
              onTouchMove={report}
            >
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              {bandBoundaries(measurementOfUnit(unit), scale.domain).map((y) => (
                <ReferenceLine key={`band-${y}`} y={y} stroke={BAND_LINE} strokeWidth={1} zIndex={BAND_LINE_Z} />
              ))}
              {/* Draws nothing; keeps recharts tracking the hovered month. */}
              <Tooltip content={() => null} cursor={{ stroke: "#9aa5ab", strokeWidth: 1 }} />
              <XAxis
                dataKey="label"
                interval={0}
                height={X_AXIS_HEIGHT}
                tick={{ fontSize: 11, fill: "#5c6b73" }}
                stroke="#d4d8da"
                tickLine={false}
              />
              <YAxis
                domain={scale.domain}
                ticks={scale.ticks}
                tick={{ fontSize: 11, fill: "#5c6b73" }}
                stroke="#d4d8da"
                tickLine={false}
                width={52}
              >
                <Label
                  value={axisLabelOfUnit(unit)}
                  angle={-90}
                  position="insideLeft"
                  style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
                />
              </YAxis>
              <Area
                dataKey="band"
                stroke="none"
                fill={BAND_COLOUR}
                fillOpacity={0.16}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              {yearsShown.map((y) => (
                <Line
                  key={y.year}
                  dataKey={`y${y.year}`}
                  stroke={y.year === latest ? LATEST_YEAR_COLOUR : YEAR_COLOUR}
                  strokeOpacity={y.year === latest ? 0.9 : 0.45}
                  strokeWidth={y.year === latest ? 1.6 : 1}
                  dot={false}
                  activeDot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
              <Line
                dataKey="mean"
                stroke={MEAN_COLOUR}
                strokeWidth={2}
                dot={{ r: 2, fill: MEAN_COLOUR }}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="sparse"
                stroke="none"
                dot={{ r: 3, fill: "#fff", stroke: SPARSE_COLOUR, strokeWidth: 1.5 }}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <BandStrip
          measurement={measurementOfUnit(unit)}
          domain={scale.domain}
          top={TOP_MARGIN}
          bottom={X_AXIS_HEIGHT}
        />
      </div>

      {/* Key, and the switch for the per-year lines. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3" style={{ background: MEAN_COLOUR }} />
          {isAqi ? "Average daily AQI" : "Average daily level"}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm" style={{ background: BAND_COLOUR, opacity: 0.3 }} />
          Average daily low to high
        </span>
        {hasSparse && (
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full border"
              style={{ borderColor: SPARSE_COLOUR }}
            />
            Too few years to call typical
          </span>
        )}
        {data.years.length > 1 && (
          <label className="ml-auto inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={showYears}
              onChange={(e) => setShowYears(e.target.checked)}
            />
            Each year
            {showYears && latest !== null && (
              <span style={{ color: LATEST_YEAR_COLOUR }}>({latest} in blue)</span>
            )}
          </label>
        )}
      </div>

      {/* Footnotes: where the numbers come from, and what an AQI low/high is. */}
      <p className="mt-2 text-[11px] leading-snug text-gray-500">
        {isAqi && (
          <>
            The line is the official AQI, which is a 24-hour average. The low and high put each
            day&apos;s cleanest and worst readings on the same scale; they are not official AQI
            values.{" "}
          </>
        )}
        {stationsUsed > 1 && `Averaged over ${stationsUsed} stations. `}
        Each month is the middle (median) year.{" "}
        {data.dropped.length > 0 &&
          `Left out: ${data.dropped.length} unusual ${data.dropped.length === 1 ? "month" : "months"} at single stations, each at least ${SCREEN_FACTOR} times above or below that station's other years. `}
        Only days with at least 12 hours of readings count. Data: CPCB (via XKDR) to Sep 2025,
        OpenAQ after. Highs read slightly higher from Sep 2025, when the data became 15-minute
        rather than hourly.
      </p>
    </div>
  );
}
