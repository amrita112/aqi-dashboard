"use client";

/**
 * Measured daily values over the past month.
 *
 * Separate from ForecastChart because it is a different kind of thing: these
 * are observations, with gaps where nothing was reported, and no uncertainty
 * band — drawing one around a measurement would be nonsense.
 *
 * GAPS ARE DRAWN AS GAPS. `connectNulls` is deliberately off: a straight line
 * across four missing days looks like data, and for this network missing days
 * are the norm rather than the exception.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function HistoryChart({
  points,
  unit,
  label,
}: {
  points: { date: string; value: number }[];
  unit: string;
  label: string;
}) {
  // Fill the calendar so missing days are visible as breaks rather than being
  // closed up into a continuous line.
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  const start = new Date(`${points[0].date}T12:00:00+05:30`);
  const end = new Date(`${points[points.length - 1].date}T12:00:00+05:30`);
  const rows: { date: string; label: string; value: number | null }[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    rows.push({
      date: iso,
      label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      value: byDate.get(iso) ?? null,
    });
  }

  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(5, (hi - lo) * 0.15);
  const tickEvery = Math.max(1, Math.ceil(rows.length / 5));

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#eef0f1" />
          <XAxis
            dataKey="label"
            interval={tickEvery - 1}
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
          />
          <YAxis
            domain={[Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]}
            tick={{ fontSize: 11, fill: "#5c6b73" }}
            stroke="#d4d8da"
            tickLine={false}
            width={38}
          />
          <Tooltip formatter={(v) => [`${Math.round(Number(v))} ${unit}`.trim(), label]} />
          <Line
            dataKey="value"
            stroke="#12171b"
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-xs text-gray-500">
        Measured daily averages. Breaks are days with no reading.
      </p>
    </div>
  );
}
