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
import { useState } from "react";
import { getAqiColor } from "@/lib/aqi-utils";
import { hoveredIndex } from "@/lib/chart-hover";
import { niceScale } from "@/lib/chart-scale";
import { tickHeight, twoTierTick } from "@/components/ChartTick";
import type { AnswerChart as ChartSpec } from "@/lib/ai/chart";

/** Shorten an axis label without losing what distinguishes it. */
function shortLabel(label: string, kind: ChartSpec["kind"]): string {
  // An empty label is deliberate: hourly points between day marks carry none,
  // so only one tick per day is drawn.
  if (!label) return "";
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

/** Keep at most `max` of these tick positions, evenly spaced. */
function thin(ticks: number[], max: number): number[] {
  if (ticks.length <= max) return ticks;
  const step = Math.ceil(ticks.length / max);
  return ticks.filter((_, k) => k % step === 0);
}

export default function AnswerChart({ chart }: { chart: ChartSpec }) {
  const isAqi = chart.unit === "AQI";
  /** The point under the finger, reported beside the chart's title. */
  const [hovered, setHovered] = useState<string | null>(null);

  const data = chart.points.map((p, i) => ({
    ...p,
    i,
    short: shortLabel(p.label, chart.kind),
  }));

  // DATE AND TIME ON SEPARATE TIERS, as everywhere else in the app. An hourly
  // series puts its clock on the hour tier and carries no date; a multi-day
  // forecast puts the date at noon and the clock at 6am and 6pm.
  const hourly = chart.kind === "hourly";
  const dateTicks = thin(
    data.filter((d) => (hourly ? false : d.short !== "")).map((d) => d.i),
    7,
  );
  const hourTicks = thin(
    data.filter((d) => (hourly ? d.short !== "" : (d.sub ?? "") !== "")).map((d) => d.i),
    8,
  );
  const showHours = hourTicks.length > 0;
  const axisTicks = Array.from(new Set([...hourTicks, ...dateTicks])).sort((a, b) => a - b);
  const hourAt = new Set(hourTicks);
  const dateAt = new Set(dateTicks);
  const labelsAt = (i: number) => ({
    hour: hourAt.has(i) ? (hourly ? data[i]?.short : data[i]?.sub) || undefined : undefined,
    date: dateAt.has(i) ? data[i]?.short || undefined : undefined,
  });

  // PADDED, NOT ANCHORED AT ZERO. recharts defaults a numeric axis to a
  // zero baseline, which drew a forecast swinging between 140 and 280 as a
  // nearly flat line in the top half of the box. Rounded, so the axis reads
  // 150/200/250 rather than 130/195/260.
  const values = data.map((d) => d.value).filter((v) => Number.isFinite(v));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(5, (hi - lo) * 0.18);
  const scale = niceScale(lo - pad, hi + pad);

  const report = (state: { activeTooltipIndex?: number | string | null } | undefined) => {
    const i = hoveredIndex(state, data.length);
    const d = i === null ? undefined : data[i];
    if (!d) return setHovered(null);
    // The point's own full label, not the shortened axis one, which is blank
    // for most points.
    const when = [d.label, d.sub].filter(Boolean).join(" ") || d.short;
    setHovered(`${when ? `${when} · ` : ""}${Math.round(d.value)} ${chart.unit}`.trim());
  };

  const axis = {
    tick: { fontSize: 11, fill: "#5c6b73" },
    stroke: "#d4d8da",
  };

  return (
    <figure className="mt-4 border-t border-gray-100 pt-4">
      <figcaption className="text-xs font-medium text-gray-600">{chart.title}</figcaption>
      {/* THE READING GOES HERE, not in a floating box over the line. The
          default recharts tooltip was passed an empty series name, so it
          rendered as ": 240 AQI" — a dangling colon in a white box sitting on
          top of the data it described. Every other chart in the app reports
          into its header; this one had been missed. */}
      <p className="min-h-[1.25rem] text-xs font-medium text-gray-900">{hovered}</p>
      <div className="mt-2 h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === "compare" ? (
            <BarChart
              data={data}
              margin={{ top: 6, right: 8, left: -18, bottom: 0 }}
              onMouseMove={report}
              onTouchMove={report}
            >
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              <XAxis dataKey="short" {...axis} />
              <YAxis {...axis} width={44} />
              <Tooltip content={() => null} cursor={{ fill: "#eef0f1" }} />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {/* Band colour per bar, so the comparison reads the way the
                    rest of the app reads rather than as two neutral bars. */}
                {data.map((d, i) => (
                  <Cell key={i} fill={isAqi ? getAqiColor(d.value) : "#2a78d6"} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <LineChart
              data={data}
              margin={{ top: 6, right: 8, left: -18, bottom: 0 }}
              onMouseMove={report}
              onTouchMove={report}
            >
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              <XAxis
                dataKey="i"
                type="number"
                domain={[0, Math.max(0, data.length - 1)]}
                ticks={axisTicks}
                tick={twoTierTick(labelsAt, showHours)}
                height={tickHeight(showHours)}
                tickLine={false}
                stroke="#d4d8da"
                interval={0}
              />
              <YAxis domain={scale.domain} ticks={scale.ticks} {...axis} width={44} />
              {/* Draws nothing: recharts only tracks the active point while a
                  Tooltip is mounted, and the reading goes in the header. */}
              <Tooltip content={() => null} cursor={{ stroke: "#9aa5ab", strokeWidth: 1 }} />
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
