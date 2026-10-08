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
  isNoon: boolean;
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
}: {
  days: ForecastDayInput[];
  unit: string;
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
        label: d.label,
        isNoon: h.hour === 12,
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

  // One tick per day, at noon, so the labels sit under the middle of their day
  // rather than on the midnight boundary between two.
  const ticks = rows.filter((r) => r.isNoon).map((r) => r.i);

  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#eef0f1" />
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
            width={38}
          />
          <Tooltip
            formatter={(v) => [`${Math.round(Number(v))} ${unit}`.trim(), ""]}
            labelFormatter={(i) => rows[i as number]?.clock ?? ""}
          />
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

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5" style={{ background: FORECAST }} />
          Forecast
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-5 rounded-sm"
            style={{ background: FORECAST, opacity: 0.2 }}
          />
          Likely range
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5"
            style={{
              backgroundImage: `repeating-linear-gradient(to right, ${NORMAL} 0 5px, transparent 5px 9px)`,
            }}
          />
          Seasonal normal
        </span>
      </div>
    </div>
  );
}
