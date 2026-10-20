"use client";

/**
 * The small chart under an AI answer.
 *
 * Draws the series the tools returned — the same numbers the model was shown,
 * so the picture and the sentence cannot disagree. Nothing here decides what
 * is true; it decides how to draw what lib/ai/chart.ts already settled.
 *
 * STYLED LIKE THE TREND CHARTS since the 19 Oct review: a black line, the
 * CPCB band strip down the right edge, a tight y-axis and "PM2.5 (µg/m³)" on
 * it. A chart under an answer that looked different from the same numbers on
 * Trends would read as a different kind of thing.
 *
 * Deliberately plain otherwise: no legend, no gridlines beyond a faint
 * horizontal one. It sits under a two-sentence answer as supporting evidence,
 * not as the main event, and a chart with more furniture than data would
 * invert that.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  Cell,
  Label,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import { hoveredIndex } from "@/lib/chart-hover";
import { niceScale, tightScale } from "@/lib/chart-scale";
import { tickHeight, twoTierTick } from "@/components/ChartTick";
import BandStrip, { axisLabelOfUnit, BAND_LINE, BAND_LINE_Z, bandBoundaries, bandColorOf, measurementOfUnit } from "@/components/BandStrip";
import type { AnswerChart as ChartSpec } from "@/lib/ai/chart";

const LINE = "#12171b";
/** Space above the plot; the band strip leaves the same so the two line up. */
const TOP_MARGIN = 6;
/** The bar chart's x-axis height, fixed so the strip can match it. */
const BAR_AXIS_HEIGHT = 30;

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
  // The tools say "AQI" or "µg/m³"; the shared helpers take "" for AQI.
  const unit = chart.unit === "AQI" ? "" : chart.unit;
  const measurement = measurementOfUnit(unit);
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

  // LINES: NOT ANCHORED AT ZERO, and ending just past the data, as on Trends;
  // see lib/chart-scale. BARS: from zero, because a bar's length is its value
  // and a bar cut off at 80 makes 120 look three times 100.
  const values = data.map((d) => d.value).filter((v) => Number.isFinite(v));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const isBars = chart.kind === "compare";
  const scale = isBars ? niceScale(0, hi * 1.05) : tightScale(lo, hi);

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
      <div className="mt-2 flex h-44 w-full gap-1.5">
        <div className="h-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {isBars ? (
            <BarChart
              data={data}
              margin={{ top: TOP_MARGIN, right: 4, left: 0, bottom: 0 }}
              onMouseMove={report}
              onTouchMove={report}
            >
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              {/* Band boundaries, darker than the grid: where the air changes category. */}
              {bandBoundaries(measurement, scale.domain).map((y) => (
                <ReferenceLine key={`band-${y}`} y={y} stroke={BAND_LINE} strokeWidth={1} zIndex={BAND_LINE_Z} />
              ))}
              <XAxis dataKey="short" {...axis} height={BAR_AXIS_HEIGHT} />
              <YAxis {...axis} domain={scale.domain} ticks={scale.ticks} width={52}>
                {/* EVERY CHART IN THE APP SAYS WHAT ITS NUMBERS ARE. AQI and
                    µg/m³ are different scales with the same shape, so an
                    unlabelled axis leaves the reader no way to tell which one
                    they are looking at — and these charts sit under an answer
                    that may name either. */}
                <Label
                  value={axisLabelOfUnit(unit)}
                  angle={-90}
                  position="insideLeft"
                  style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
                />
              </YAxis>
              <Tooltip content={() => null} cursor={{ fill: "#eef0f1" }} />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {/* Band colour per bar, for PM2.5 as well as AQI. PM2.5 bars
                    used to be blue, which on the trend charts now means "the
                    second place", not a level of pollution. */}
                {data.map((d, i) => (
                  <Cell key={i} fill={bandColorOf(measurement, d.value)} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <LineChart
              data={data}
              margin={{ top: TOP_MARGIN, right: 4, left: 0, bottom: 0 }}
              onMouseMove={report}
              onTouchMove={report}
            >
              <CartesianGrid vertical={false} stroke="#eef0f1" />
              {/* Band boundaries, darker than the grid: where the air changes category. */}
              {bandBoundaries(measurement, scale.domain).map((y) => (
                <ReferenceLine key={`band-${y}`} y={y} stroke={BAND_LINE} strokeWidth={1} zIndex={BAND_LINE_Z} />
              ))}
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
              <YAxis domain={scale.domain} ticks={scale.ticks} {...axis} width={52}>
                <Label
                  value={axisLabelOfUnit(unit)}
                  angle={-90}
                  position="insideLeft"
                  style={{ fontSize: 10, fill: "#5c6b73", textAnchor: "middle" }}
                />
              </YAxis>
              {/* Draws nothing: recharts only tracks the active point while a
                  Tooltip is mounted, and the reading goes in the header. */}
              <Tooltip content={() => null} cursor={{ stroke: "#9aa5ab", strokeWidth: 1 }} />
              <Line
                type="monotone"
                dataKey="value"
                stroke={LINE}
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
                      fill={LINE}
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
        <BandStrip
          measurement={measurement}
          domain={scale.domain}
          top={TOP_MARGIN}
          bottom={isBars ? BAR_AXIS_HEIGHT : tickHeight(showHours)}
        />
      </div>
      {chart.note && <p className="mt-2 text-xs text-gray-600">{chart.note}</p>}
    </figure>
  );
}
