"use client";

/**
 * The forecast line on the home screen.
 *
 * THREE THINGS AT ONCE, which is the point: the predicted value, how uncertain
 * it is, and where prediction stops and the seasonal average begins. Drawing
 * them as one continuous line would be the easy version and would quietly imply
 * we can forecast seven days out, which we cannot — skill is gone by about day
 * four, and past that the number IS the climatology.
 *
 * So the solid line covers the days with a real forecast, and the dashed line
 * continues through the seasonal-normal tail. They share a point at the join so
 * there is no visual gap.
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

export interface ForecastPoint {
  target_date: string;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  label: string;
}

const INK = "#12171b";
const FORECAST = "#c2410c";
const NORMAL = "#5c6b73";

export default function ForecastChart({
  points,
  unit,
}: {
  points: ForecastPoint[];
  unit: string;
}) {
  if (points.length < 2) return null;

  const firstNormal = points.findIndex((p) => p.mode === "seasonal_normal");
  const splitAt = firstNormal === -1 ? points.length : firstNormal;

  const data = points.map((p, i) => ({
    label: p.label,
    // Solid through the forecast days; the join point belongs to both series so
    // the two lines meet instead of leaving a gap.
    forecast: i < splitAt ? p.value : i === splitAt ? p.value : null,
    normal: i >= splitAt - 1 ? p.value : null,
    // Recharts draws a stacked area from a [low, high] pair.
    range:
      p.band_low !== null && p.band_high !== null
        ? ([p.band_low, p.band_high] as [number, number])
        : null,
  }));

  const values = points.flatMap((p) =>
    [p.value, p.band_low, p.band_high].filter((v): v is number => v !== null),
  );
  // Padded bounds. Letting recharts pick made a rising forecast look flat,
  // because it anchored the axis at zero.
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(8, (hi - lo) * 0.25);

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#eef0f1" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
          />
          <YAxis
            domain={[Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]}
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
            width={44}
          />
          <Tooltip
            formatter={(v) => [`${Math.round(Number(v))} ${unit}`.trim(), ""]}
            labelFormatter={(l) => String(l)}
          />
          {splitAt < points.length && splitAt > 0 && (
            <ReferenceLine
              x={data[splitAt - 1]?.label}
              stroke="#d4d8da"
              strokeDasharray="3 3"
            />
          )}
          <Area
            dataKey="range"
            stroke="none"
            fill={FORECAST}
            fillOpacity={0.13}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="forecast"
            stroke={FORECAST}
            strokeWidth={2.4}
            dot={{ r: 3, fill: FORECAST, strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="normal"
            stroke={NORMAL}
            strokeWidth={1.8}
            strokeDasharray="5 4"
            dot={{ r: 3, fill: NORMAL, strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls
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
            style={{ background: FORECAST, opacity: 0.18 }}
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
      <p className="sr-only" style={{ color: INK }}>
        Forecast values by day.
      </p>
    </div>
  );
}
