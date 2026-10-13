"use client";

/**
 * One or two places on the same axes.
 *
 * Separate from ForecastChart because the question is different. That chart
 * draws ONE place and spends its ink distinguishing forecast from seasonal
 * normal; this one draws up to TWO places and spends its ink distinguishing
 * them from each other. Trying to do both at once would need four line styles
 * and would read as none.
 *
 * `low`/`high` draw a shaded band — the likely range for a forecast, the day's
 * min-to-max for history. Labelled in the legend either way, because an
 * unlabelled band is just a smudge.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Label,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { hoveredIndex } from "@/lib/chart-hover";
import { niceScale } from "@/lib/chart-scale";
import { tickHeight, twoTierTick } from "@/components/ChartTick";

export interface SeriesPoint {
  /** Day/date tier of the axis; empty for points between ticks. */
  label: string;
  /**
   * Hour tier of the axis, on a separate row from the date.
   *
   * One axis alternating "6am 12 Oct 6pm" mixed two vocabularies in one line
   * and grouped neither with what it belonged to. Dates go on the lower tier,
   * clock times on the upper one, and a caller that has no hours simply omits
   * this and gets one tier.
   */
  hourLabel?: string;
  /** Readout label, always present. */
  full: string;
  value: number | null;
  low?: number | null;
  high?: number | null;
  /** True where the number is the seasonal average rather than a prediction. */
  seasonal?: boolean;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  points: SeriesPoint[];
}

export const SERIES_COLORS = ["#c2410c", "#2a78d6"];

/**
 * What the chart reports under the finger.
 *
 * STRUCTURED, NOT A SENTENCE. With two places the readout was one grey string
 * — "28 Sep · Pune (city average): 40 Delhi NCR · Lodhi Road: 24 µg/m³" —
 * where the only cue separating one place from the next was a middle dot, and
 * the names are long enough that the eye loses which number belongs to which.
 * Handing the caller the parts lets each place be printed in its own line
 * colour, which is the same cue the chart itself uses.
 */
export interface HoverReading {
  /** The moment, e.g. "28 Sep" or "13 Oct, 7pm". */
  when: string;
  values: { label: string; value: string; color: string }[];
  unit: string;
}

export default function TrendsChart({
  series,
  unit,
  bandLabel,
  solidLabel = "Forecast",
  threshold,
  height = 208,
  showKey = true,
  onHover,
}: {
  series: Series[];
  unit: string;
  /** What the shaded band means here, e.g. "likely range" or "day's min–max". */
  bandLabel?: string;
  /** What a SOLID line means, shown only when a dashed one is also drawn. */
  solidLabel?: string;
  threshold?: number | null;
  height?: number;
  /** Off when the caller already shows the colours, e.g. as place pills. */
  showKey?: boolean;
  /** Hovered point, for the caller to render above the chart. */
  onHover?: (reading: HoverReading | null) => void;
}) {
  const live = series.filter((s) => s.points.some((p) => p.value !== null));
  if (!live.length) return null;

  // Rows are keyed off the longest series, so two places of different lengths
  // still line up on the x-axis instead of one being silently truncated.
  const spine = live.reduce((a, b) => (b.points.length > a.points.length ? b : a));
  const rows = spine.points.map((p, i) => {
    const row: Record<string, string | number | null | [number, number]> = {
      i,
      label: p.label,
      hourLabel: p.hourLabel ?? "",
      full: p.full,
    };
    for (const s of live) {
      const q = s.points[i];
      // SEASONAL SEGMENTS ARE DASHED, as on the home screen. Drawn solid, a
      // seasonal average looks like a forecast, which is the one thing the
      // rest of this app is careful never to imply.
      const seasonal = q?.seasonal === true;
      row[s.key] = seasonal ? null : (q?.value ?? null);
      row[`${s.key}__seasonal`] = seasonal ? (q?.value ?? null) : null;
      // The join: the last real point also starts the dashed run, so the two
      // meet instead of leaving a gap.
      const prev = s.points[i - 1];
      if (seasonal && prev && prev.seasonal !== true) row[s.key] = q?.value ?? null;
      if (!seasonal && prev?.seasonal === true) row[`${s.key}__seasonal`] = q?.value ?? null;
      if (q?.low != null && q?.high != null) row[`${s.key}__band`] = [q.low, q.high];
    }
    return row;
  });

  const values = live.flatMap((s) =>
    s.points.flatMap((p) =>
      [p.value, p.low ?? null, p.high ?? null].filter((v): v is number => v !== null),
    ),
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values, ...(threshold != null ? [threshold] : []));
  // Padded around the data, never anchored at zero: a flat-looking line is a
  // chart that has thrown away the thing it was drawn to show.
  const pad = Math.max(5, (hi - lo) * 0.18);
  // Round numbers on the axis; see lib/chart-scale.
  const scale = niceScale(lo - pad, hi + pad);

  const sparse = rows.some((r) => r.label === "") && rows.some((r) => r.label !== "");
  const ticks = sparse
    ? rows.filter((r) => r.label !== "").map((r) => r.i as number)
    : undefined;

  // The hour tier, present only when the caller supplied clock labels AND
  // there are few enough to read. A seven-day hourly view asks for 6am and 6pm
  // on every day, which is fourteen labels across a 350px phone axis — they
  // collide, and a row of overlapping times is worse than no row at all. Past
  // the cap the clock comes from the readout above the chart, which gives the
  // exact hour under the finger rather than the nearest label.
  const MAX_HOUR_LABELS = 8;
  const allHourTicks = rows.filter((r) => r.hourLabel !== "").map((r) => r.i as number);
  const hourTicks = allHourTicks.length <= MAX_HOUR_LABELS ? allHourTicks : [];
  const showHours = hourTicks.length > 0;

  // One axis, two lines of text. See components/ChartTick for why this is not
  // two <XAxis> elements.
  // THINNED. A 30-day history labels every row, and 30 dates across a phone's
  // width overprinted into an unreadable smear. Seven is what fits.
  const MAX_DATE_LABELS = 7;
  const allDateTicks = ticks ?? rows.map((r) => r.i as number);
  const dateStep = Math.ceil(allDateTicks.length / MAX_DATE_LABELS);
  const dateTicks =
    allDateTicks.length <= MAX_DATE_LABELS
      ? allDateTicks
      : allDateTicks.filter((_, k) => k % dateStep === 0);
  const dateShown = new Set(dateTicks);
  const axisTicks = Array.from(new Set([...hourTicks, ...dateTicks])).sort((a, b) => a - b);
  const labelsAt = (i: number) => ({
    hour: (rows[i]?.hourLabel as string) || undefined,
    date: dateShown.has(i) ? (rows[i]?.label as string) || undefined : undefined,
  });

  // A seasonal tail is drawn dashed; say so only when one is present.
  const hasSeasonal = live.some((s) => s.points.some((p) => p.seasonal === true));

  // WHICH SERIES THE SWATCHES SHOULD BE COLOURED FOR. These entries describe
  // line STYLES — solid, shaded, dashed — not places, and the legend used
  // live[0]'s colour for all of them. Comparing Lodhi Road (orange) with
  // Kolkata (blue), where only Kolkata had a band, drew an orange swatch
  // beside a blue band and said they were the same thing.
  //
  // With one place on the chart, matching its colour is right and helps. With
  // two, no single colour is honest, so the swatch goes neutral: the pills
  // above the chart already say which place is which colour.
  const banded = live.filter((s) => s.points.some((p) => p.low != null && p.high != null));
  const hasBand = banded.length > 0;
  const NEUTRAL = "#5c6b73";
  const styleColour = (owners: typeof live) =>
    owners.length === 1 ? owners[0].color : NEUTRAL;

  /**
   * Report the point under the pointer. Shared by the mouse and touch events so
   * a phone and a laptop can never show different things.
   */
  const report = (
    state: { activeTooltipIndex?: number | string | null } | undefined,
  ) => {
    if (!onHover) return;
    const i = hoveredIndex(state, rows.length);
    const r = i === null ? undefined : rows[i];
    if (!r) return onHover(null);
    const values = live
      .map((s) => {
        const v = (r[s.key] ?? r[`${s.key}__seasonal`]) as number | null;
        return v === null || v === undefined
          ? null
          : { label: s.label, value: String(Math.round(v)), color: s.color };
      })
      .filter((v): v is { label: string; value: string; color: string } => v !== null);
    onHover(values.length ? { when: String(r.full ?? ""), values, unit } : null);
  };

  return (
    <div className="w-full">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
            // Reported in the card header rather than a floating box: the box
            // covered the line it described, and listed the shaded band as a
            // [low, high] pair, which formats as "NaN".
            onMouseMove={report}
            // AND ON TOUCH. recharts fires onMouseMove only for a mouse, so a
            // finger dragged across the chart moved the cursor line and
            // reported nothing — the readout never appeared on a phone.
            onTouchMove={report}
            // NO onMouseLeave. On a touchscreen the leave event fires immediately
          // after the tap, so the reading appeared and vanished in the same frame
          // — which is what Amrita saw on her phone: the cursor line stayed, the
          // number never did. Leaving the last value up is also better on a
          // mouse: it is still the answer to the last thing you pointed at.
          >
            <CartesianGrid vertical={false} stroke="#eef0f1" />
            {/* A Tooltip that draws NOTHING. Recharts only tracks
                activeTooltipIndex while a Tooltip is mounted, so removing it took the
                hover readout with it: onMouseMove fired with nothing to report. This
                keeps the tracking and the cursor line and renders no box, because the
                reading goes in the card header. */}
            <Tooltip content={() => null} cursor={{ stroke: "#9aa5ab", strokeWidth: 1 }} />
            <XAxis
              dataKey="i"
              type="number"
              domain={[0, rows.length - 1]}
              ticks={axisTicks}
              tick={twoTierTick(labelsAt, showHours)}
              height={tickHeight(showHours)}
              stroke="#d4d8da"
              tickLine={false}
              interval={sparse ? 0 : "preserveStartEnd"}
            />
            <YAxis
              domain={scale.domain}
              ticks={scale.ticks}
              tick={{ fontSize: 11, fill: "#5c6b73" }}
              stroke="#d4d8da"
              tickLine={false}
              width={52}
            >
              {/* AQI and µg/m³ are different scales with the same shape; an
                  unlabelled axis gave the reader no way to tell them apart. */}
              <Label
                value={unit ? `${unit}` : "AQI"}
                angle={-90}
                position="insideLeft"
                style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
              />
            </YAxis>
            {threshold != null && (
              <ReferenceLine
                y={threshold}
                stroke="#b3261e"
                strokeDasharray="4 3"
                label={{ value: "your alert level", position: "insideTopRight", fontSize: 10, fill: "#b3261e" }}
              />
            )}
            {live.map((s) => (
              <Area
                key={`${s.key}-band`}
                dataKey={`${s.key}__band`}
                stroke="none"
                fill={s.color}
                fillOpacity={0.14}
                isAnimationActive={false}
              />
            ))}
            {live.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.key}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
            {live.map((s) => (
              <Line
                key={`${s.key}-seasonal`}
                dataKey={`${s.key}__seasonal`}
                stroke={s.color}
                strokeWidth={1.6}
                strokeDasharray="5 4"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        {showKey &&
          live.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-5" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        {/* ONLY WHEN THERE IS A DASHED LINE TO CONTRAST WITH. This entry
            explains that solid means prediction and dashed means seasonal
            average. On the History card there is no dashed line, nothing to
            distinguish, and the word was simply wrong: it labelled measured
            readings "Forecast". */}
        {hasSeasonal && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5" style={{ background: styleColour(live) }} />
            {solidLabel}
          </span>
        )}
        {hasBand && bandLabel && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-5 rounded-sm"
              style={{ background: styleColour(banded), opacity: 0.25 }}
            />
            {bandLabel}
          </span>
        )}
        {hasSeasonal && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-5"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, ${styleColour(live)} 0 5px, transparent 5px 9px)`,
              }}
            />
            Seasonal normal
          </span>
        )}
      </div>
    </div>
  );
}
