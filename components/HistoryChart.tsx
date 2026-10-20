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
  ReferenceLine,
  Label,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { tightScale } from "@/lib/chart-scale";
import BandStrip, { axisLabelOfUnit, BAND_LINE, BAND_LINE_Z, bandBoundaries, measurementOfUnit } from "@/components/BandStrip";

/** Plot margins, shared with the band strip so its ends meet the plot's. */
const TOP_MARGIN = 8;
const X_AXIS_HEIGHT = 30;

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
  // The same tight axis as the forecast and Trends charts; see lib/chart-scale.
  const scale = tightScale(Math.min(...values), Math.max(...values));
  const tickEvery = Math.max(1, Math.ceil(rows.length / 5));

  return (
    // Same reason as ForecastChart: the caption must sit outside the sized box
    // or it overlaps the content below.
    <div className="w-full">
      <div className="flex h-48 w-full gap-1.5">
      <div className="h-full min-w-0 flex-1">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: TOP_MARGIN, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#eef0f1" />
          {/* Band boundaries, darker than the grid: where the air changes category. */}
          {bandBoundaries(measurementOfUnit(unit), scale.domain).map((y) => (
            <ReferenceLine key={`band-${y}`} y={y} stroke={BAND_LINE} strokeWidth={1} zIndex={BAND_LINE_Z} />
          ))}
          <XAxis
            dataKey="label"
            height={X_AXIS_HEIGHT}
            interval={tickEvery - 1}
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
            {/* Names the pollutant, not only the unit, as on every chart. */}
            <Label
              value={axisLabelOfUnit(unit)}
              angle={-90}
              position="insideLeft"
              style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
            />
          </YAxis>
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
      </div>
      <BandStrip
        measurement={measurementOfUnit(unit)}
        domain={scale.domain}
        top={TOP_MARGIN}
        bottom={X_AXIS_HEIGHT}
      />
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Measured daily averages. Breaks are days with no reading.
      </p>
    </div>
  );
}
