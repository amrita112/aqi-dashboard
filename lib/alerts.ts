/**
 * Deciding whether to tell someone tomorrow looks bad.
 *
 * The threshold is compared against the forecast VALUE, not its band. The user
 * typed a number at setup, so the number is what they meant — "above 380" has
 * to mean 381, not "whenever the band tips into Very Poor".
 *
 * A seasonal_normal day NEVER produces an alert, only a softer notice. That
 * mode exists because no recent reading was available, so the figure is the
 * long-run average for the date rather than a prediction. Saying "tomorrow
 * will be above your threshold" on the strength of a seasonal average would be
 * exactly the overclaiming the mode column is drawn to prevent — and it would
 * fire on most days of a Delhi winter regardless of what the air is doing.
 *
 * Shared between the in-app banner and, later, the push sender, so the two can
 * never disagree about what counts as a bad day.
 */

import type { Measurement } from "@/lib/prefs";
import { MEASUREMENT_COPY } from "@/lib/prefs";

export type AlertLevel =
  /** A real forecast, above the threshold. Worth interrupting someone for. */
  | "alert"
  /** Only the seasonal average is above it. Worth knowing, not worth a push. */
  | "seasonal"
  /** Below the threshold, or nothing to say. */
  | "none";

export interface AlertDecision {
  level: AlertLevel;
  headline: string;
  body: string;
  /** Whether this would justify a push notification, not just a banner. */
  pushworthy: boolean;
  value: number;
  threshold: number;
}

export interface ForecastLike {
  value: number;
  mode: string;
  target_date: string;
  band: { label: string };
}

export function decideAlert(
  forecast: ForecastLike | null,
  threshold: number | null,
  measurement: Measurement,
): AlertDecision | null {
  // null is an explicit "do not notify me" from setup, not a missing answer.
  if (threshold === null || !forecast) return null;

  const { value, mode } = forecast;
  if (!Number.isFinite(value) || value < threshold) return null;

  const copy = MEASUREMENT_COPY[measurement];
  const rounded = Math.round(value);
  const unit = copy.unit ? ` ${copy.unit}` : "";
  const reading = `${rounded}${unit}`;

  if (mode === "seasonal_normal") {
    return {
      level: "seasonal",
      headline: `A typical day this time of year is above your ${threshold} limit`,
      // Says plainly that this is not a forecast, and why.
      body: `There is no recent reading from the stations near you, so the best we can offer for tomorrow is the seasonal average — ${reading}. That is above the level you set, but it is not a forecast of tomorrow specifically.`,
      pushworthy: false,
      value: rounded,
      threshold,
    };
  }

  return {
    level: "alert",
    headline: `Tomorrow is forecast above your ${threshold} limit`,
    body: `${reading} — ${forecast.band.label.toLowerCase()} — against the ${threshold}${unit} you asked to hear about.`,
    pushworthy: true,
    value: rounded,
    threshold,
  };
}
