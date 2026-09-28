/**
 * Telling the user how good the data behind an answer actually is — and
 * offering them something to do about it.
 *
 * This is not a disclaimer bolted on at the end. The staleness is structural
 * and permanent: OpenAQ republishes India's CPCB network on a lag, and
 * measured on 2026-09-28 across all locations within 25 km of each city centre,
 * ZERO government stations had reported within 48 hours:
 *
 *   Delhi      80 government stations, median age  3.9 days
 *   Mumbai     43 government stations, median age  3.9 days
 *   Bengaluru  20 government stations, median age  9.2 days
 *
 * The only genuinely live sources are six privately-run AirGradient sensors
 * across all three cities. So "the air right now" is a question this product
 * usually cannot answer, and pretending otherwise would be the one thing the
 * whole forecast pipeline is built to avoid.
 *
 * Saying so plainly turns a weakness into the product's most honest moment,
 * and into the two things a user can actually do: put a sensor where they
 * live, or back hyperlocal measurement being built.
 *
 * One deliberate constraint on the copy below: it never implies the user has
 * done something wrong, and it never overstates what either action delivers.
 * Connecting your own monitor is a V2 capability and is labelled as such.
 */

export type QualityLevel = "live" | "recent" | "stale" | "very_stale";

export interface CallToAction {
  id: "connect_monitor" | "support_hyperlocal";
  label: string;
  body: string;
  /** Screens decide placement; this ranks them when space is short. */
  priority: number;
  /** V2 capabilities are labelled so nobody is promised something today. */
  available: boolean;
}

export interface DataQuality {
  level: QualityLevel;
  age_hours: number;
  age_days: number;
  /** One line, safe to put straight on a card. */
  headline: string;
  /** Why it is stale — the honest mechanism, not an apology. */
  explanation: string;
  /** True when the staleness is what pushed the forecast to a seasonal average. */
  affects_forecast: boolean;
  /** Empty when the data is live; a user with good data needs no nudge. */
  actions: CallToAction[];
}

const CONNECT_MONITOR: CallToAction = {
  id: "connect_monitor",
  label: "Put a monitor where you live",
  body:
    "A sensor at your home reports every few minutes instead of every few days, and in the next version you will be able to connect it here so your own readings drive your forecast.",
  priority: 1,
  available: false, // V2 — do not imply it works today
};

const SUPPORT_HYPERLOCAL: CallToAction = {
  id: "support_hyperlocal",
  label: "Back hyperlocal measurement",
  body:
    "Add your name to the case for measuring air street by street, rather than relying on a handful of government stations that report days late.",
  priority: 2,
  available: true,
};

/** Past this, "current" is not an honest word for a reading. */
export const STALE_AFTER_HOURS = 24;

/**
 * The line between "published late" and "the monitor has gone quiet", and it
 * is drawn from the measurement rather than from intuition.
 *
 * Delhi and Mumbai sit at a MEDIAN age of 3.9 days, Bengaluru at 9.2. Those are
 * the normal case, not a failure — the stations are reporting, OpenAQ
 * republishes them on a delay. Telling a typical user "no monitor near you has
 * reported for 4 days" would be alarmist and, more importantly, wrong about the
 * mechanism.
 *
 * Ten days clears Bengaluru's median, so only genuine silence trips the
 * harsher wording.
 */
const VERY_STALE_AFTER_HOURS = 24 * 10;
const RECENT_AFTER_HOURS = 6;

export function assessDataQuality(
  ageHours: number | null,
  opts: { servingSeasonalNormal?: boolean; stationCount?: number } = {},
): DataQuality {
  const age = ageHours ?? Number.POSITIVE_INFINITY;
  const ageDays = Number.isFinite(age) ? Math.round((age / 24) * 10) / 10 : Infinity;
  const affects = opts.servingSeasonalNormal ?? false;

  if (age <= RECENT_AFTER_HOURS) {
    return {
      level: "live",
      age_hours: round1(age),
      age_days: ageDays,
      headline: "Measured in the last few hours",
      explanation:
        "A nearby monitor is reporting continuously, so this is close to the air outside right now.",
      affects_forecast: false,
      actions: [],
    };
  }

  if (age <= STALE_AFTER_HOURS) {
    return {
      level: "recent",
      age_hours: round1(age),
      age_days: ageDays,
      headline: `Measured about ${Math.round(age)} hours ago`,
      explanation:
        "Government monitors publish on a delay, so readings reach us a few hours to a few days after they are taken.",
      affects_forecast: affects,
      actions: [SUPPORT_HYPERLOCAL],
    };
  }

  const plural = (n: number) => (n === 1 ? "day" : "days");
  const wholeDays = Math.max(1, Math.round(age / 24));

  if (age <= VERY_STALE_AFTER_HOURS) {
    return {
      level: "stale",
      age_hours: round1(age),
      age_days: ageDays,
      headline: `The nearest monitors last reported ${wholeDays} ${plural(wholeDays)} ago`,
      explanation: affects
        ? "India's government monitors are republished on a delay of several days, and that is too old to predict tomorrow from — so the number above is the seasonal average for this time of year rather than a forecast."
        : "India's government monitors are republished on a delay of several days, so this is the most recent measurement available, not a live one.",
      affects_forecast: affects,
      actions: [CONNECT_MONITOR, SUPPORT_HYPERLOCAL],
    };
  }

  return {
    level: "very_stale",
    age_hours: Number.isFinite(age) ? round1(age) : -1,
    age_days: Number.isFinite(ageDays) ? ageDays : -1,
    headline: Number.isFinite(age)
      ? `No monitor near you has reported for ${wholeDays} ${plural(wholeDays)}`
      : "No recent measurement from any monitor near you",
    explanation:
      "Measuring air quality here depends on a small number of government stations, and they can go quiet for weeks at a time. Until one reports again, the number above is the seasonal average for this time of year — not a forecast.",
    affects_forecast: affects,
    actions: [CONNECT_MONITOR, SUPPORT_HYPERLOCAL],
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
