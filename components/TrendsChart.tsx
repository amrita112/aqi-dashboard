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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface SeriesPoint {
  /** Axis label; empty for points between ticks. */
  label: string;
  /** Tooltip label, always present. */
  full: string;
  value: number | null;
  low?: number | null;
  high?: number | null;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  points: SeriesPoint[];
}

export const SERIES_COLORS = ["#c2410c", "#2a78d6"];

export default function TrendsChart({
  series,
  unit,
  bandLabel,
  threshold,
  height = 208,
}: {
  series: Series[];
  unit: string;
  /** What the shaded band means here, e.g. "likely range" or "day's min–max". */
  bandLabel?: string;
  threshold?: number | null;
  height?: number;
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
      full: p.full,
    };
    for (const s of live) {
      const q = s.points[i];
      row[s.key] = q?.value ?? null;
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

  const sparse = rows.some((r) => r.label === "") && rows.some((r) => r.label !== "");
  const ticks = sparse
    ? rows.filter((r) => r.label !== "").map((r) => r.i as number)
    : undefined;

  const hasBand = live.some((s) => s.points.some((p) => p.low != null && p.high != null));

  return (
    <div className="w-full">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef0f1" />
            <XAxis
              dataKey="i"
              type="number"
              domain={[0, rows.length - 1]}
              ticks={ticks}
              tickFormatter={(i) => String(rows[i as number]?.label ?? "")}
              tick={{ fontSize: 11, fill: "#5c6b73" }}
              stroke="#d4d8da"
              tickLine={false}
              interval={sparse ? 0 : "preserveStartEnd"}
            />
            <YAxis
              domain={[Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]}
              tick={{ fontSize: 11, fill: "#5c6b73" }}
              stroke="#d4d8da"
              tickLine={false}
              width={40}
            />
            <Tooltip
              formatter={(v, name) => [
                `${Math.round(Number(v))}${unit ? ` ${unit}` : ""}`,
                live.find((s) => s.key === name)?.label ?? String(name),
              ]}
              labelFormatter={(i) => String(rows[i as number]?.full ?? "")}
            />
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
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        {live.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {hasBand && bandLabel && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-5 rounded-sm"
              style={{ background: live[0].color, opacity: 0.2 }}
            />
            {bandLabel}
          </span>
        )}
      </div>
    </div>
  );
}
