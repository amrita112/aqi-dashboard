"use client";

/**
 * The forecast line on the home screen — HOURLY, not daily.
 *
 * The app's model is daily level x diurnal shape, and plotting one point per
 * day threw the second half away: the chart was a nearly straight line between
 * five dots, which is both less informative and less honest than what the
 * model actually says. Air quality in these cities swings by a factor of two
 * within a day, and "when today" is the question people act on.
 *
 * THREE THINGS AT ONCE. The predicted value, how uncertain it is, and where
 * prediction stops and the seasonal average begins:
 *
 *   solid    hours with a real forecast or outlook
 *   dashed   the seasonal-normal tail, where the number IS the climatology
 *   shaded   the likely range, which EXISTS ONLY FOR FORECAST DAYS
 *
 * The shaded band disappearing partway across is not a rendering gap. A
 * seasonal average has no uncertainty band stored for it, because it is not a
 * prediction and inventing a range around it would dress it up as one.
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

export interface ForecastDayInput {
  target_date: string;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  hourly: { hour: number; value: number; band_low?: number | null; band_high?: number | null }[] | null;
  label: string;
}

const FORECAST = "#c2410c";
const NORMAL = "#5c6b73";

interface Row {
  i: number;
  label: string;
  isTick: boolean;
  forecast: number | null;
  normal: number | null;
  range: [number, number] | null;
  clock: string;
}

function clockOf(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${suffix}`;
}

export default function ForecastChart({
  days,
  unit,
  onHover,
  heightClass = "h-52",
}: {
  days: ForecastDayInput[];
  unit: string;
  /** Hovered point, for the caller to show beside the card title. */
  onHover?: (text: string | null) => void;
  /**
   * Plot height. A share of the viewport rather than a fixed height, so the
   * home screen keeps the sketch's proportions on a tall phone and a short
   * one; clamped at both ends so it cannot collapse or balloon.
   */
  heightClass?: string;
}) {
  const rows: Row[] = [];
  let firstNormalIndex = -1;

  for (const d of days) {
    const hours = d.hourly?.length
      ? d.hourly
      : // No fitted diurnal shape for this city and month: fall back to the flat
        // daily value rather than dropping the day off the chart.
        Array.from({ length: 24 }, (_, hour) => ({
          hour,
          value: d.value,
          band_low: d.band_low,
          band_high: d.band_high,
        }));

    for (const h of hours) {
      const seasonal = d.mode === "seasonal_normal";
      if (seasonal && firstNormalIndex === -1) firstNormalIndex = rows.length;
      const lo = h.band_low ?? null;
      const hi = h.band_high ?? null;
      rows.push({
        i: rows.length,
        // The day's name at noon, a bare hour at 6am and 6pm, nothing between.
        label: h.hour === 12 ? d.label : h.hour === 6 || h.hour === 18 ? clockOf(h.hour) : "",
        isTick: h.hour === 6 || h.hour === 12 || h.hour === 18,
        forecast: seasonal ? null : h.value,
        normal: seasonal ? h.value : null,
        range: lo !== null && hi !== null ? [lo, hi] : null,
        clock: `${d.label} ${clockOf(h.hour)}`,
      });
    }
  }

  if (rows.length < 4) return null;

  // Join the two lines: the last forecast point also starts the dashed one, so
  // they meet instead of leaving a one-hour hole.
  if (firstNormalIndex > 0) rows[firstNormalIndex - 1].normal = rows[firstNormalIndex - 1].forecast;

  const values = rows.flatMap((r) =>
    [r.forecast, r.normal, r.range?.[0] ?? null, r.range?.[1] ?? null].filter(
      (v): v is number => v !== null,
    ),
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Padded around the data, never anchored at zero: a rising forecast was being
  // drawn as a flat line against a zero baseline.
  const pad = Math.max(6, (hi - lo) * 0.18);

  // TICKS AT SIX-HOURLY MARKS, not one per day. With the diurnal curve drawn,
  // a label only at noon left no way to read WHEN a peak was — Amrita's point
  // that showing the within-day shape is useless if the reader cannot place it
  // against the clock. Days still get their name; the marks between get an
  // hour.
  const ticks = rows.filter((r) => r.isTick).map((r) => r.i);

  // What is actually drawn, so the key below can describe only that.
  const hasForecast = rows.some((r) => r.forecast !== null);
  const hasNormal = rows.some((r) => r.normal !== null);
  const hasBand = rows.some((r) => r.range !== null);

  /**
   * Report the point under the pointer to the caller, for mouse and finger
   * alike. One function used by both events so they cannot drift apart.
   */
  // recharts types the index as number | string | null: a categorical chart
  // can key its tooltip by label rather than position. Ours is numeric, hence
  // the typeof check below rather than a cast.
  const report = (
    state: { activeTooltipIndex?: number | string | null } | undefined,
  ) => {
    if (!onHover) return;
    const i = state?.activeTooltipIndex;
    const r = typeof i === "number" ? rows[i] : undefined;
    const v = r?.forecast ?? r?.normal;
    onHover(
      r && v !== null && v !== undefined
        ? `${r.clock} · ${Math.round(v)}${unit ? ` ${unit}` : ""}`
        : null,
    );
  };

  return (
    // The fixed height belongs to the PLOT ONLY. With the legend inside the
    // sized box it overflowed the bottom and printed on top of whatever
    // followed -- on the map card, the "cleanest hours" line.
    <div className="w-full">
      <div className={`${heightClass} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
          // THE READOUT GOES IN THE HEADER, not in a floating box. The tooltip
          // sat on top of the line it was describing, and listed the shaded
          // band as a second row — a [low, high] pair, which formats as
          // "NaN µg/m³". Reporting the hovered point in the card header leaves
          // the chart unobscured and has nothing to mis-format.
          onMouseMove={report}
          // AND ON TOUCH, which is the only way most people will ever use this.
          // recharts fires onMouseMove from a mouse ONLY; a finger dragged
          // across the chart moved the cursor line but called nothing, so the
          // readout stayed empty on a phone — the chart looked broken on the
          // device it was designed for. recharts does track the active point on
          // touchmove, so the same handler on the touch event is the whole fix.
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
            ticks={ticks}
            tickFormatter={(i) => rows[i as number]?.label ?? ""}
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
          />
          <YAxis
            domain={[Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]}
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
            // Wide enough for three digits. At 44 with a negative left margin
            // the labels were clipped, so 122 rendered as "22".
            width={52}
          >
            {/* SAYS WHAT THE NUMBERS ARE. A chart of unlabelled values could
                be AQI or µg/m³, which are different scales with the same
                shape — the reader had no way to tell which. */}
            <Label
              value={unit ? `${unit}` : "AQI"}
              angle={-90}
              position="insideLeft"
              style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
            />
          </YAxis>
          {firstNormalIndex > 0 && (
            <ReferenceLine x={firstNormalIndex} stroke="#d4d8da" strokeDasharray="3 3" />
          )}
          <Area
            dataKey="range"
            stroke="none"
            fill={FORECAST}
            fillOpacity={0.15}
            isAnimationActive={false}
          />
          <Line
            dataKey="forecast"
            stroke={FORECAST}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="normal"
            stroke={NORMAL}
            strokeWidth={1.6}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      </div>

      {/* ONLY WHAT IS ON THE CHART. With every day a seasonal normal the key
          still advertised "Forecast" and "Likely range", so it described a
          picture the reader could not see and implied we had predictions we do
          not have. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        {hasForecast && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5" style={{ background: FORECAST }} />
            Forecast
          </span>
        )}
        {hasBand && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-5 rounded-sm"
              style={{ background: FORECAST, opacity: 0.2 }}
            />
            Likely range
          </span>
        )}
        {hasNormal && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-5"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, ${NORMAL} 0 5px, transparent 5px 9px)`,
              }}
            />
            Seasonal normal
          </span>
        )}
      </div>
    </div>
  );
}
