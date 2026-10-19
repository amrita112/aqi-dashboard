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
 * Aligned by padding: the caller says how much space the chart leaves above
 * the plot (its top margin) and below it (the x-axis), and the strip leaves
 * the same, so its top and bottom are the plot's top and bottom.
 */

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
        label: b.label,
        color: b.color,
        // Measured from the top, because that is how CSS positions things.
        topPct: ((hi - segHi) / span) * 100,
        heightPct: ((segHi - segLo) / span) * 100,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <div className="w-1.5 shrink-0" style={{ paddingTop: top, paddingBottom: bottom }} aria-hidden="true">
      <div className="relative h-full overflow-hidden rounded-full">
        {segments.map((s) => (
          <div
            key={s.label}
            title={s.label}
            className="absolute inset-x-0"
            style={{ top: `${s.topPct}%`, height: `${s.heightPct}%`, background: s.color }}
          />
        ))}
      </div>
    </div>
  );
}
