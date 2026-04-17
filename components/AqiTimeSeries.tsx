/**
 * AQI Time Series Chart — shows how AQI changes over time for a selected location.
 *
 * "use client" because charts require browser-side JavaScript to render.
 * Uses Recharts (a charting library built for React).
 *
 * Think of this like a line chart in Excel — the x-axis is time,
 * the y-axis is the AQI value, and each dot is a reading.
 */
"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Reading } from "@/lib/types";

interface AqiTimeSeriesProps {
  readings: Reading[];
  /** Optional title override — used to show the selected location's coordinates */
  title?: string;
}

export default function AqiTimeSeries({ readings, title }: AqiTimeSeriesProps) {
  /* If there are no readings, show instruction text instead of an empty chart */
  if (readings.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Click a station or anywhere on the map to see AQI trends for that area
      </div>
    );
  }

  /**
   * Transform readings into the format Recharts expects.
   * Each item needs a label for the x-axis (time) and a value for the y-axis (AQI).
   */
  const chartData = readings
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
    .map((r) => ({
      time: new Date(r.recorded_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      aqi: r.aqi_value,
    }));

  return (
    <div>
      {title && (
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          {/* Grid lines in the background (like graph paper) */}
          <CartesianGrid strokeDasharray="3 3" />

          {/* X-axis: time labels */}
          <XAxis
            dataKey="time"
            tick={{ fontSize: 12 }}
            angle={-30}
            textAnchor="end"
            height={60}
          />

          {/* Y-axis: AQI values (0–500) */}
          <YAxis domain={[0, 500]} tick={{ fontSize: 12 }} />

          {/* Tooltip: shows the exact value when you hover over a point */}
          <Tooltip />

          {/* Reference lines at EPA category boundaries.
              These horizontal lines help you see at a glance which category
              the readings fall into. */}
          <ReferenceLine y={50} stroke="#00e400" strokeDasharray="3 3" label="Good" />
          <ReferenceLine y={100} stroke="#ffff00" strokeDasharray="3 3" label="Moderate" />
          <ReferenceLine y={150} stroke="#ff7e00" strokeDasharray="3 3" label="Sensitive" />
          <ReferenceLine y={200} stroke="#ff0000" strokeDasharray="3 3" label="Unhealthy" />

          {/* The actual line connecting the data points */}
          <Line
            type="monotone"
            dataKey="aqi"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ fill: "#3b82f6", r: 4 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
