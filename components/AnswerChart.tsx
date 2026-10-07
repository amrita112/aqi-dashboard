"use client";

/**
 * The small chart under an AI answer.
 *
 * Draws the series the tools returned — the same numbers the model was shown,
 * so the picture and the sentence cannot disagree. Nothing here decides what
 * is true; it decides how to draw what lib/ai/chart.ts already settled.
 *
 * Deliberately plain: no axis titles, no legend, no gridlines beyond a faint
 * horizontal one. It sits under a two-sentence answer as supporting evidence,
 * not as the main event, and a chart with more furniture than data would
 * invert that.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getAqiColor } from "@/lib/aqi-utils";
import type { AnswerChart as ChartSpec } from "@/lib/ai/chart";

/** Shorten an axis label without losing what distinguishes it. */
function shortLabel(label: string, kind: ChartSpec["kind"]): string {
  if (kind === "hourly") {
    // "6:00 pm" -> "6pm", which is what people say and fits the axis.
    return label.replace(/:00\s*/, "").replace(/\s+/g, "");
  }
  if (kind === "daily" || kind === "history") {
    // "2026-10-09" -> "9 Oct"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
    if (!m) return label;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
  }
  return label;
}

export default function AnswerChart({ chart }: { chart: ChartSpec }) {
  const isAqi = chart.unit === "AQI";
  const data = chart.points.map((p) => ({
    ...p,
    short: shortLabel(p.label, chart.kind),
  }));

  // Enough points that every tick would overlap; show roughly six.
  const tickGap = Math.max(0, Math.ceil(data.length / 6) - 1);

  const axis = {
    tick: { fontSize: 11, fill: "#5c6b73" },
    stroke: "#d4d8da",
  };

  return (
    <figure className="mt-4 border-t border-gray-100 pt-4">
      <figcaption className="text-xs font-medium text-gray-600">{chart.title}</figcaption>
      <div className="mt-2 h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === "compare" ? (
            <BarChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              <XAxis dataKey="short" {...axis} />
              <YAxis {...axis} width={44} />
              <Tooltip
                formatter={(v) => [`${Math.round(Number(v))} ${chart.unit}`, ""] as [string, string]}
                labelFormatter={(l) => String(l)}
              />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {/* Band colour per bar, so the comparison reads the way the
                    rest of the app reads rather than as two neutral bars. */}
                {data.map((d, i) => (
                  <Cell key={i} fill={isAqi ? getAqiColor(d.value) : "#2a78d6"} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              <XAxis dataKey="short" interval={tickGap} {...axis} />
              <YAxis {...axis} width={44} />
              <Tooltip
                formatter={(v) => [`${Math.round(Number(v))} ${chart.unit}`, ""] as [string, string]}
                labelFormatter={(l) => String(l)}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#2a78d6"
                strokeWidth={2}
                // One dot per point is noise at 24 hourly points; the
                // highlighted one still shows, because it is the hour the
                // sentence names.
                dot={(props) => {
                  const d = data[props.index as number];
                  if (!d?.highlight) return <g key={props.index} />;
                  return (
                    <circle
                      key={props.index}
                      cx={props.cx}
                      cy={props.cy}
                      r={4}
                      fill="#2a78d6"
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  );
                }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {chart.note && <p className="mt-2 text-xs text-gray-600">{chart.note}</p>}
    </figure>
  );
}
