"use client";

/**
 * The CPCB band colours as a thin vertical strip down a chart's right edge.
 *
 * WHY. With the line drawn in black, the colour of the air has to come from
 * somewhere, and putting it on the line itself mixed two meanings into one
 * mark (which place, and how bad). A strip beside the y-axis says "this
 * height is Moderate" without touching the line.
 *
 * ONLY THE BANDS THE CHART ACTUALLY SHOWS, at the same scale as the y-axis.
 * The strip covers the chart's own domain, so a forecast running 40 to 110
 * µg/m³ shows Satisfactory, Moderate and Poor lined up with the values that
 * fall in them — not all six bands squeezed into a legend that does not
 * line up with anything.
 *
 * NAMED, in small sideways text beside each colour, because a colour alone
 * asks the reader to already know that orange is Poor. Sideways so the names
 * cost one narrow column rather than a wide one. A name is left out when its
 * band is too short on screen to hold it — the colour is still there, and a
 * clipped "Satisfa" is worse than none. "Very Poor" is shortened to "V. Poor"
 * here only (legends elsewhere keep the full name) so it fits more often.
 *
 * Aligned by padding: the caller says how much space the chart leaves above
 * the plot (its top margin) and below it (the x-axis), and the strip leaves
 * the same, so its top and bottom are the plot's top and bottom.
 */

import { useEffect, useRef, useState } from "react";
import { bandsFor } from "@/components/BandLegend";
import type { Measurement } from "@/lib/prefs";

/** Charts know their unit, not the measurement: "" is AQI, anything else PM2.5. */
export function measurementOfUnit(unit: string): Measurement {
  return unit ? "pm25" : "aqi";
}

/** "PM2.5 (µg/m³)" or "AQI" — the y-axis label, which names the pollutant, not only the unit. */
export function axisLabelOfUnit(unit: string): string {
  return unit ? `PM2.5 (${unit})` : "AQI";
}

/** The band colour a value falls in, for marks that carry the colour themselves (bars). */
export function bandColorOf(measurement: Measurement, value: number): string {
  const bands = bandsFor(measurement);
  const hit = bands.find((b) => b.to === null || value <= b.to);
  return (hit ?? bands[bands.length - 1]).color;
}

/**
 * Grey for the band boundary lines across the plot: darker than the grid
 * (#eef0f1) so a boundary reads as different from a tick, light enough that
 * the data line stays the darkest thing on the chart.
 */
export const BAND_LINE = "#c4c9cd";

/**
 * The band boundaries that fall inside a chart's y-range, for drawing as
 * horizontal lines. The same breakpoints the strip's colours change at, so
 * each line runs out from a colour change on the strip.
 */
export function bandBoundaries(measurement: Measurement, domain: [number, number]): number[] {
  const [lo, hi] = domain;
  return bandsFor(measurement)
    .map((b) => b.to)
    .filter((to): to is number => to !== null && to > lo && to < hi);
}

/** Shorter names for the strip, where every character costs chart height. */
const SHORT_LABEL: Record<string, string> = { "Very Poor": "V. Poor" };

export default function BandStrip({
  measurement,
  domain,
  top,
  bottom,
}: {
  measurement: Measurement;
  domain: [number, number];
  /** Pixels between the top of the chart box and the top of the plot. */
  top: number;
  /** Pixels between the bottom of the plot and the bottom of the chart box. */
  bottom: number;
}) {
  // The strip's height in pixels, to decide which names fit. Measured rather
  // than assumed, because each chart sizes itself to the screen.
  const box = useRef<HTMLDivElement>(null);
  const [heightPx, setHeightPx] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeightPx(el.clientHeight));
    ro.observe(el);
    setHeightPx(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const [lo, hi] = domain;
  const span = hi - lo;
  if (!(span > 0)) return null;

  // Each band runs from the previous band's upper limit to its own, so the
  // AQI bands' 50/51 seams leave no gap.
  const bands = bandsFor(measurement);
  const segments = bands
    .map((b, i) => {
      const from = i === 0 ? 0 : (bands[i - 1].to ?? b.from);
      const to = b.to ?? Infinity;
      const segLo = Math.max(from, lo);
      const segHi = Math.min(to, hi);
      if (segHi <= segLo) return null;
      return {
        label: SHORT_LABEL[b.label] ?? b.label,
        color: b.color,
        // Measured from the top, because that is how CSS positions things.
        topPct: ((hi - segHi) / span) * 100,
        heightPct: ((segHi - segLo) / span) * 100,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  /** Roughly 5.5px per character at 10px type, plus a little breathing room. */
  const fits = (label: string, heightPct: number) =>
    heightPx > 0 && (heightPct / 100) * heightPx >= label.length * 5.5 + 6;

  return (
    <div className="flex shrink-0 gap-0.5" style={{ paddingTop: top, paddingBottom: bottom }} aria-hidden="true">
      <div className="relative w-1.5 overflow-hidden rounded-full">
        {segments.map((s) => (
          <div
            key={s.label}
            title={s.label}
            className="absolute inset-x-0"
            style={{ top: `${s.topPct}%`, height: `${s.heightPct}%`, background: s.color }}
          />
        ))}
      </div>
      <div ref={box} className="relative w-3">
        {segments.map((s) =>
          fits(s.label, s.heightPct) ? (
            <div
              key={s.label}
              className="absolute inset-x-0 flex items-center justify-center"
              style={{ top: `${s.topPct}%`, height: `${s.heightPct}%` }}
            >
              {/* Read bottom to top, the way a rotated axis label is. */}
              <span
                className="whitespace-nowrap text-[10px] leading-none text-gray-600"
                style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
              >
                {s.label}
              </span>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
