"use client";

/**
 * Historical trends: the yearly pattern of one or two places, month by month.
 *
 * Shared by the Map tab's station card (StationDetail, one station) and the
 * Trends tab's History card (TrendsScreen, one or two places), so both draw
 * the same thing the same way. This component fetches its own data from
 * /api/climate -- the caller only says which station(s) or place(s), and in
 * which measure.
 *
 * A CLIENT COMPONENT, not a server one: it reacts to the finger (the reading
 * under it), and both cards it sits in are client components already.
 *
 * WHAT IS DRAWN, for each place
 *   line         the average day: each month's average daily mean, the
 *                median year (unusual station-years screened out first;
 *                lib/api/climate.ts)
 *   band         the average daily low to the average daily high
 *   hollow dots  months with too few years behind them to call typical
 *                (lib/api/climate.ts, DEFAULT_MIN_YEARS); no band there
 *
 * TWO PLACES, ONE CHART. Comparing places follows the Trends tab's Forecast
 * and History cards (components/TrendsChart.tsx): the first place in black,
 * the second in blue (SERIES_COLORS), each with its own band in a light wash
 * of its own colour, and the coloured pills at the top of the Trends screen
 * acting as the legend. The key's swatches go neutral grey with two places,
 * because they describe line STYLES (line, band, dot), not places.
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
import { SERIES_COLORS } from "@/components/TrendsChart";
import { MEASUREMENT_COPY, type Measurement } from "@/lib/prefs";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Plot margins, shared with the band strip so its ends meet the plot's. */
const TOP_MARGIN = 8;
const X_AXIS_HEIGHT = 24;

/**
 * Colours. The FIRST place keeps the grey band and grey hollow dots the chart
 * has always had (the AQI footnote calls it "the shaded gray region"). A
 * second place's band and dots are drawn in its own colour, as the Trends
 * tab's other cards do for a second place.
 */
const BAND_COLOUR = "#5c6b73";
const BAND_OPACITY = 0.16;
/** Opacity of a second place's band: TrendsChart's band opacity. */
const OTHER_BAND_OPACITY = 0.14;
const SPARSE_COLOUR = "#9aa5ab";
/** Key swatches when two places are drawn: TrendsChart's NEUTRAL. */
const NEUTRAL = "#5c6b73";

/** One place to draw. `color` defaults to SERIES_COLORS by position. */
export interface ClimatePlace {
  /** Stable identity, e.g. TrendsPlace.key or the station's monitor_id. */
  key: string;
  /** On-screen name, used in the readout and header when two are compared. */
  label: string;
  /**
   * Which station or place: the same query the other charts send, e.g.
   * { monitor_id } or { lat, lng, k, max_km?, city? }.
   */
  query: Record<string, string>;
  color?: string;
}

/** What came back for one place. */
interface Loaded {
  data: ClimateResult | null;
  stationsUsed: number;
  error: string | null;
}

type Row = Record<string, number | string | null | [number, number]>;

export default function ClimateChart({
  places,
  measurement,
  stationWord = "monitoring station",
  height = 192,
}: {
  places: ClimatePlace[];
  measurement: Measurement;
  /**
   * How the empty message names what was asked about, e.g. "monitoring
   * station" or "place".
   */
  stationWord?: string;
  height?: number;
}) {
  // One answer per place, in the same order as `places`; null while loading.
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const unit = MEASUREMENT_COPY[measurement].unit;

  // Stable dependency: the places array is rebuilt on every render upstream,
  // so the effect keys on the query strings it would actually send.
  const qsList = useMemo(
    () => places.map((p) => new URLSearchParams({ ...p.query, metric: measurement }).toString()),
    [places, measurement],
  );
  const qsKey = qsList.join("|");

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setHover(null);
    (async () => {
      // All places at once; one failing does not stop the other drawing.
      const answers = await Promise.all(
        qsKey.split("|").map(async (qs): Promise<Loaded> => {
          try {
            const r = await fetch(`/api/climate?${qs}`);
            const b = await r.json();
            if (b?.error) return { data: null, stationsUsed: 0, error: b.error.message };
            return {
              data: b.data as ClimateResult,
              stationsUsed: Number(b.meta?.stations_used ?? 0),
              error: null,
            };
          } catch {
            return { data: null, stationsUsed: 0, error: "Could not reach the server." };
          }
        }),
      );
      if (!cancelled) setLoaded(answers);
    })();
    return () => {
      cancelled = true;
    };
  }, [qsKey]);

  if (loaded === null || loaded.length !== places.length) {
    return <p className="py-10 text-center text-sm text-gray-500">Loading…</p>;
  }

  // Each place with its answer and colour, in order.
  const all = places.map((p, idx) => ({
    ...p,
    ...loaded[idx],
    idx,
    color: p.color ?? SERIES_COLORS[idx] ?? NEUTRAL,
  }));
  // The places that have something to draw.
  const live = all.filter((p) => p.data !== null && p.data.n_years > 0);
  const failed = all.filter((p) => p.error !== null);
  const comparing = places.length > 1;

  if (live.length === 0) {
    if (failed.length > 0) {
      return <p className="py-6 text-center text-sm text-red-700">{failed[0].error}</p>;
    }
    return (
      <p className="py-10 text-center text-sm text-gray-500">
        No complete months on record for this {stationWord} yet.
      </p>
    );
  }

  // One row per month. For each place p: m{p} the mean, s{p} the hollow dot
  // for a thin month, b{p} the low-to-high band. The mean and band only where
  // enough years stand behind it; otherwise a hollow dot and no band.
  const rows: Row[] = MONTH_NAMES.map((name, i) => {
    const row: Row = { i, label: name[0] };
    for (const p of live) {
      const m = p.data!.months[i];
      row[`m${p.idx}`] = m.enough_years ? m.mean : null;
      row[`s${p.idx}`] = !m.enough_years ? m.mean : null;
      row[`b${p.idx}`] = m.enough_years && m.min !== null && m.max !== null ? [m.min, m.max] : null;
    }
    return row;
  });

  const values = live
    .flatMap((p) => p.data!.months.flatMap((m) => [m.mean, m.min, m.max]))
    .filter((v): v is number => typeof v === "number");
  const scale = tightScale(Math.min(...values), Math.max(...values));

  const report = (state: { activeTooltipIndex?: number | string | null } | undefined) =>
    setHover(hoveredIndex(state, rows.length));

  const fmt = (v: number | null) => (v === null ? "–" : String(Math.round(v)));
  const hasSparse = live.some((p) => p.data!.months.some((m) => !m.enough_years && m.mean !== null));
  const isAqi = measurement === "aqi";
  // Key swatch colours: the place's own with one place, neutral with two.
  const lineSwatch = comparing ? NEUTRAL : live[0].color;

  /**
   * How many monitoring stations stand behind a place, in words, for the
   * explainer. The count is what the API says answered (meta.stations_used),
   * never a fixed number. A single station asked for by monitor_id (the Map
   * tab) is "this monitoring station".
   */
  const stationsSentence = (p: (typeof live)[number]): string => {
    if (p.query.monitor_id) return "From this monitoring station.";
    if (p.stationsUsed === 1) return "From 1 monitoring station.";
    return `Averaged over ${p.stationsUsed} monitoring stations.`;
  };
  const totalDropped = live.reduce((t, p) => t + p.data!.dropped.length, 0);

  return (
    <div className="w-full">
      {/* How much history stands behind the chart, said first. One line per
          place when two are compared, each in its line colour. */}
      {all.map((p) => {
        const d = p.data;
        if (!comparing && (!d || d.n_years === 0)) return null;
        return (
          <p
            key={p.key}
            className="text-xs text-gray-600"
            style={comparing ? { color: p.color } : undefined}
          >
            {comparing ? `${p.label}: ` : ""}
            {p.error
              ? "could not load."
              : !d || d.n_years === 0
                ? "no complete months on record yet."
                : (
                  <>
                    {d.n_years} {d.n_years === 1 ? "year" : "years"} ({d.first_year}
                    {d.last_year !== d.first_year ? `–${d.last_year}` : ""})
                    {p.stationsUsed > 1 ? ` · ${p.stationsUsed} monitoring stations` : ""}
                  </>
                )}
          </p>
        );
      })}

      {/* The reading under the finger. Height reserved so the chart does not
          jump as a finger moves; two lines' worth when two places share it. */}
      <p
        className={`mt-0.5 text-xs font-medium text-gray-900 ${comparing ? "min-h-[2rem]" : "min-h-[1.25rem]"}`}
      >
        {hover !== null && live.some((p) => p.data!.months[hover].mean !== null) && (
          <>
            {MONTH_NAMES[hover]}:
            {live.map((p) => {
              const m = p.data!.months[hover];
              if (m.mean === null) return null;
              return comparing ? (
                <span key={p.key} className="ml-2 whitespace-nowrap" style={{ color: p.color }}>
                  {p.label}: {fmt(m.mean)}
                  <span className="font-normal"> ({fmt(m.min)}–{fmt(m.max)})</span>
                </span>
              ) : (
                <span key={p.key}>
                  {" "}
                  {fmt(m.mean)}
                  <span className="font-normal text-gray-600">
                    {" "}
                    (low {fmt(m.min)}, high {fmt(m.max)}){unit ? ` ${unit}` : ""} ·{" "}
                    {m.n_years} {m.n_years === 1 ? "year" : "years"}
                  </span>
                </span>
              );
            })}
            {comparing && unit ? <span className="ml-1 font-normal text-gray-500">{unit}</span> : null}
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
              {/* Bands first, so every line is drawn on top of every band. */}
              {live.map((p) => (
                <Area
                  key={`band-${p.key}`}
                  dataKey={`b${p.idx}`}
                  stroke="none"
                  fill={p.idx === 0 ? BAND_COLOUR : p.color}
                  fillOpacity={p.idx === 0 ? BAND_OPACITY : OTHER_BAND_OPACITY}
                  activeDot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
              {live.map((p) => (
                <Line
                  key={`mean-${p.key}`}
                  dataKey={`m${p.idx}`}
                  stroke={p.color}
                  strokeWidth={2}
                  dot={{ r: 2, fill: p.color }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
              {live.map((p) => (
                <Line
                  key={`sparse-${p.key}`}
                  dataKey={`s${p.idx}`}
                  stroke="none"
                  dot={{
                    r: 3,
                    fill: "#fff",
                    stroke: p.idx === 0 ? SPARSE_COLOUR : p.color,
                    strokeOpacity: p.idx === 0 ? 1 : 0.6,
                    strokeWidth: 1.5,
                  }}
                  activeDot={false}
                  isAnimationActive={false}
                />
              ))}
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

      {/* Key. Which colour is which place is said by the pills on the Trends
          screen, as for the other cards there. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3" style={{ background: lineSwatch }} />
          {isAqi ? "Average daily AQI" : "Average daily level"}
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: comparing ? NEUTRAL : BAND_COLOUR, opacity: 0.3 }}
          />
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
      </div>

      {/* Footnotes: what an AQI low/high is, then how many monitoring stations
          and where the numbers come from (the owner's wording), then two short
          caveats. */}
      <p className="mt-2 text-[11px] leading-snug text-gray-500">
        {isAqi &&
          (comparing ? (
            <>
              The black and blue lines are the official AQI, which is a 24-hour average. The daily
              low and high (shaded regions) put each day&apos;s cleanest and worst readings on the
              same scale; they are not official AQI values.{" "}
            </>
          ) : (
            <>
              The black line is the official AQI, which is a 24-hour average. The daily low and
              high (shaded gray region) put each day&apos;s cleanest and worst readings on the same
              scale; they are not official AQI values.{" "}
            </>
          ))}
        {comparing
          ? live.map((p) => `${p.label}: ${stationsSentence(p).toLowerCase().replace(/\.$/, "")}. `).join("")
          : `${stationsSentence(live[0])} `}
        Values are median over years. Data: CPCB (via XKDR and OpenAQ).
      </p>
      <p className="mt-1 text-[11px] leading-snug text-gray-400">
        {totalDropped > 0 &&
          `Left out: ${totalDropped} unusual ${totalDropped === 1 ? "month" : "months"} at single monitoring stations (each at least ${SCREEN_FACTOR}× above or below that monitoring station's other years). `}
        Highs read slightly higher from Sep 2025, when readings became 15-minute.
      </p>
    </div>
  );
}
