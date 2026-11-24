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

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
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
  /** meta.furthest_km: how far the furthest contributing station is. */
  furthestKm: number | null;
  error: string | null;
}

/**
 * One place's answer, handed to the caller through `onLoaded`, so a card can
 * build a share message or compare the places' stations without asking the
 * server a second time.
 */
export interface ClimateAnswer extends Loaded {
  key: string;
}

type Row = Record<string, number | string | null | [number, number]>;

export default function ClimateChart({
  places,
  measurement,
  stationWord = "monitoring station",
  height = 192,
  plotRef,
  onLoaded,
  hiddenKeys,
}: {
  places: ClimatePlace[];
  measurement: Measurement;
  /**
   * How the empty message names what was asked about, e.g. "monitoring
   * station" or "place".
   */
  stationWord?: string;
  height?: number;
  /**
   * Attached to the plot and its key only -- what a SHARED image captures.
   * The lines above and below the plot name places by their on-screen
   * labels (possibly the person's own nickname), so they are left out; the
   * share image draws its own public names (lib/chart-image.ts).
   */
  plotRef?: Ref<HTMLDivElement>;
  /** Called with every place's answer once all have come back. */
  onLoaded?: (answers: ClimateAnswer[]) => void;
  /**
   * Places loaded but NOT drawn, by key: the Trends tab hides the second
   * place when both use exactly the same monitoring stations (their lines
   * would be identical; lib/same-stations.ts). Kept loaded rather than
   * removed from `places`, so hiding does not refetch or re-trigger onLoaded.
   */
  hiddenKeys?: readonly string[];
}) {
  // One answer per place, in the same order as `places`; null while loading.
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const unit = MEASUREMENT_COPY[measurement].unit;
  // The latest props, read when answers arrive, so the fetch effect below
  // can stay keyed on the query strings alone.
  const latest = useRef({ places, onLoaded });
  latest.current = { places, onLoaded };

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
            if (b?.error) return { data: null, stationsUsed: 0, furthestKm: null, error: b.error.message };
            return {
              data: b.data as ClimateResult,
              stationsUsed: Number(b.meta?.stations_used ?? 0),
              furthestKm: typeof b.meta?.furthest_km === "number" ? b.meta.furthest_km : null,
              error: null,
            };
          } catch {
            return { data: null, stationsUsed: 0, furthestKm: null, error: "Could not reach the server." };
          }
        }),
      );
      if (cancelled) return;
      setLoaded(answers);
      const { places: now, onLoaded: report } = latest.current;
      report?.(answers.map((a, i) => ({ ...a, key: now[i]?.key ?? String(i) })));
    })();
    return () => {
      cancelled = true;
    };
  }, [qsKey]);

  if (loaded === null || loaded.length !== places.length) {
    return <p className="py-10 text-center text-sm text-gray-500">Loading…</p>;
  }

  // Each place with its answer and colour, in order, less any the caller
  // asked to hide (colours keep their position, so the first stays black).
  const all = places
    .map((p, idx) => ({
      ...p,
      ...loaded[idx],
      idx,
      color: p.color ?? SERIES_COLORS[idx] ?? NEUTRAL,
    }))
    .filter((p) => !hiddenKeys?.includes(p.key));
  // The places that have something to draw.
  const live = all.filter((p) => p.data !== null && p.data.n_years > 0);
  const failed = all.filter((p) => p.error !== null);
  const comparing = all.length > 1;

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
   * never a fixed number.
   *
   * A single station asked for by monitor_id (the Map tab's station card)
   * gets NO sentence (null): the card is that one monitoring station, so
   * saying "From this monitoring station." there only repeats the obvious
   * (the owner's call). The footnote then starts straight at "Values are
   * median over years."
   */
  const stationsSentence = (p: (typeof live)[number]): string | null => {
    if (p.query.monitor_id) return null;
    if (p.stationsUsed === 1) return "From 1 monitoring station.";
    return `Averaged over ${p.stationsUsed} monitoring stations.`;
  };
  // Each place's sentence for the footnote, already joined. With two places,
  // each is prefixed by the place's name and lower-cased to run on after it
  // ("Delhi: averaged over 12 monitoring stations. "); a place with no
  // sentence (a single station by monitor_id) is skipped entirely, so no
  // dangling "Name: ." is left behind.
  const stationsFootnote = comparing
    ? live
        .map((p) => {
          const s = stationsSentence(p);
          return s ? `${p.label}: ${s.toLowerCase().replace(/\.$/, "")}. ` : "";
        })
        .join("")
    : (() => {
        const s = stationsSentence(live[0]);
        return s ? `${s} ` : "";
      })();
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
            // Wraps like ordinary text; "break-words" also splits a single
            // over-long word, so a long name can never push past the card.
            className="min-w-0 break-words text-xs text-gray-600"
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

      {/* The reading under the finger.

          ONE PLACE (the Map tab, or the Trends tab with one place): a single
          line, "February: 120 (low 72, high 230) · 9 years", which wraps
          normally if it is too long. One line's height is reserved so the
          chart does not jump as a finger arrives or leaves.

          TWO PLACES (the Trends tab comparing): the month on its own line,
          then each place on its own line beneath it, in its line colour
          (first black, second blue). It used to be one unbreakable line per
          place ("whitespace-nowrap"), which with long monitoring station
          names ran past the card's right edge and was cut off. Now each
          place's line may wrap ("break-words" also splits a single very long
          word), and "min-w-0" stops a long name from widening the card.

          NO JUMP WHEN TWO PLACES ARE COMPARED. How tall the readout is
          depends on how many lines each place's name wraps onto, which only
          the browser knows. So rather than guess a fixed height, the readout
          is ALWAYS drawn: when no finger is on the chart it is drawn with
          stand-in numbers and made invisible ("invisible" hides it but keeps
          its space). The real readout then takes the same space, so the chart
          stays still. (Real numbers can be a digit or two shorter or longer
          than the stand-ins, which at worst changes a wrap on rare widths.) */}
      {comparing ? (
        (() => {
          // Hovered month, but only if at least one place has a value for it;
          // otherwise behave as if nothing is hovered.
          const active =
            hover !== null && live.some((p) => p.data!.months[hover].mean !== null) ? hover : null;
          return (
            <div
              className={`mt-0.5 min-w-0 text-xs font-medium text-gray-900 ${active === null ? "invisible" : ""}`}
              // The stand-in readout is for spacing only; screen readers skip it.
              aria-hidden={active === null ? true : undefined}
            >
              <p className="break-words">
                {/* Month name only: the unit is already on the y-axis label
                    ("PM2.5 (µg/m³)"), so repeating it here was clutter. */}
                {active === null ? "September" : MONTH_NAMES[active]}
              </p>
              {live.map((p) => {
                const m = active === null ? null : p.data!.months[active];
                return (
                  <p key={p.key} className="min-w-0 break-words" style={{ color: p.color }}>
                    {p.label}:{" "}
                    {m === null ? (
                      // Stand-in, as wide as a typical reading.
                      <>000<span className="font-normal"> (000–000)</span></>
                    ) : m.mean === null ? (
                      // This place has no record for the month; a dash keeps
                      // its line (and so the height) in place.
                      "–"
                    ) : (
                      <>
                        {fmt(m.mean)}
                        <span className="font-normal"> ({fmt(m.min)}–{fmt(m.max)})</span>
                      </>
                    )}
                  </p>
                );
              })}
            </div>
          );
        })()
      ) : (
        <p className="mt-0.5 min-h-[1.25rem] min-w-0 break-words text-xs font-medium text-gray-900">
          {hover !== null && live[0].data!.months[hover].mean !== null && (
            <>
              {MONTH_NAMES[hover]}:
              {live.map((p) => {
                const m = p.data!.months[hover];
                if (m.mean === null) return null;
                return (
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
            </>
          )}
        </p>
      )}

      {/* The plot and its key: what a shared image captures (plotRef). */}
      <div ref={plotRef}>
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
      </div>

      {/* Footnotes: what an AQI low/high is, then how many monitoring stations
          and where the numbers come from (the owner's wording), then the
          months the unusual-year screen left out, when there are any. */}
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
        {stationsFootnote}
        Values are median over years. Data is from CPCB (via XKDR and OpenAQ).
      </p>
      {/* Only when the unusual-year screen left something out. */}
      {totalDropped > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-gray-400">
          {`Left out: ${totalDropped} unusual ${totalDropped === 1 ? "month" : "months"} at single monitoring stations (each at least ${SCREEN_FACTOR}× above or below that monitoring station's other years).`}
        </p>
      )}
    </div>
  );
}
