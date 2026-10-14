"use client";

/**
 * What the number means, in six colours.
 *
 * WHY THIS IS ON THE HOME SCREEN. A tester saw "52 SATISFACTORY" in green for
 * PM2.5 and did not believe it. He was right to check and the app was right:
 * CPCB puts 30-60 µg/m³ in the Satisfactory band. But almost nobody knows the
 * PM2.5 bands — the 0-500 AQI scale is familiar in India and the µg/m³ one is
 * not, so a green box with a number in it is unreadable unless you already
 * know where the boundaries are.
 *
 * So the scale goes where the number is, rather than on a page nobody opens.
 * It also quietly shows what people are usually surprised by: that the band
 * boundaries are close together down at the clean end, so small changes
 * matter most when the air is already good.
 *
 * THE BOUNDARIES ARE THE POLLUTANT'S, NOT THE INDEX'S. Showing 0-50 / 51-100
 * next to a PM2.5 reading would be wrong — those are AQI points. For PM2.5 the
 * same six bands sit at 30 / 60 / 90 / 120 / 250 µg/m³, which is the thing
 * worth learning.
 */

import config from "@/lib/aqi-config.json";
import type { Measurement } from "@/lib/prefs";

interface Band {
  label: string;
  color: string;
  from: number;
  to: number | null;
}

/** The six bands, expressed in whatever the person is reading. */
export function bandsFor(measurement: Measurement): Band[] {
  const scale = config.scales.naqi;
  if (measurement === "aqi") {
    return scale.categories.map((c) => ({
      label: c.label,
      color: c.color,
      from: c.min,
      to: c.max >= 500 ? null : c.max,
    }));
  }
  // PM2.5: the concentration breakpoints that map onto the same six bands.
  const bp = scale.breakpoints.pm25;
  return scale.categories.map((c, i) => ({
    label: c.label,
    color: c.color,
    from: bp[i]?.c_lo ?? 0,
    // The top band is open-ended; CPCB defines no upper limit for it.
    to: i === scale.categories.length - 1 ? null : (bp[i]?.c_hi ?? null),
  }));
}

export default function BandLegend({
  measurement,
  value,
}: {
  measurement: Measurement;
  /** Today's number, so the band it falls in can be marked. */
  value?: number | null;
}) {
  const bands = bandsFor(measurement);
  const unit = measurement === "pm25" ? "µg/m³" : "";

  return (
    <div className="w-full">
      <div className="flex w-full overflow-hidden rounded-md">
        {bands.map((b) => {
          // The band the current reading sits in, marked rather than labelled:
          // the big coloured number already says which one it is, and this
          // only has to show WHERE that is on the scale.
          const here =
            value !== null &&
            value !== undefined &&
            value >= b.from &&
            (b.to === null || value < b.to);
          return (
            <div
              key={b.label}
              className="flex-1"
              style={{
                background: b.color,
                height: here ? 14 : 8,
                // A dark notch, because the band colours themselves run from
                // green to maroon and no single highlight colour reads on all
                // six.
                boxShadow: here ? "inset 0 0 0 2px rgba(0,0,0,0.65)" : undefined,
              }}
              title={`${b.label}: ${b.from}${b.to === null ? "+" : `–${b.to}`} ${unit}`.trim()}
            />
          );
        })}
      </div>

      {/* The boundary numbers, under the joins they belong to. Only the
          interior ones: "0" at the left edge is noise and the top band has no
          upper limit to print. */}
      <div className="mt-1 flex w-full text-[9px] leading-none text-gray-500">
        {bands.map((b, i) => (
          <div key={b.label} className="flex-1 text-right">
            {i < bands.length - 1 ? <span className="-mr-2 inline-block">{b.to}</span> : null}
          </div>
        ))}
      </div>

      <div className="mt-1 flex w-full justify-between text-[10px] font-medium text-gray-600">
        <span>Good</span>
        <span>{unit || "AQI"}</span>
        <span>Severe</span>
      </div>
    </div>
  );
}
