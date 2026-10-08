/**
 * Turns a tool result into a small chart the answer can stand on.
 *
 * WHY THIS IS NOT THE MODEL'S JOB. The obvious design is to let the model emit
 * chart data, and it is the wrong one: the whole premise of this feature is
 * that every number comes from the database and none from the model. A chart
 * the model wrote would be a picture of numbers it chose, which is exactly the
 * thing the system prompt forbids in prose. So the chart is built here, in
 * TypeScript, from the SAME tool result the model was shown — it cannot
 * disagree with the answer because neither of them invented anything.
 *
 * Only series worth drawing get one. A single current reading is a number, and
 * drawing one bar for it is decoration pretending to be evidence.
 */

export interface ChartPoint {
  label: string;
  value: number;
  /** Set when a point is the one the sentence is about, so it can be marked. */
  highlight?: boolean;
}

export interface AnswerChart {
  kind: "hourly" | "daily" | "history" | "compare";
  title: string;
  /** Axis unit, already human-readable. */
  unit: string;
  points: ChartPoint[];
  /** Shown under the chart. Carries the staleness or seasonal-normal caveat. */
  note: string | null;
}

/** Below this there is no shape to see, only a couple of dots. */
const MIN_POINTS = 3;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function unitFor(pollutant: unknown): string {
  return pollutant === "pm25" ? "µg/m³" : "AQI";
}

/**
 * `mode` is the difference between a forecast and the seasonal average, and a
 * chart that does not say which is quietly overclaiming.
 */
function modeNote(mode: unknown): string | null {
  if (mode === "seasonal_normal") {
    return "This is the seasonal average for these dates, not a prediction — no recent reading was available to forecast from.";
  }
  if (mode === "outlook") return "An outlook: further ahead, so less certain than a next-day forecast.";
  return null;
}

export function chartFor(tool: string, result: unknown): AnswerChart | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.error) return null;

  switch (tool) {
    case "rest_of_today": {
      const hourly = Array.isArray(r.hourly) ? r.hourly : [];
      const points: ChartPoint[] = [];
      for (const h of hourly) {
        const row = h as Record<string, unknown>;
        const v = num(row.value);
        if (v === null) continue;
        points.push({ label: String(row.clock ?? row.hour_ist ?? ""), value: v });
      }
      if (points.length < MIN_POINTS) return null;
      // Mark the cleanest hour, because that is the hour the sentence names and
      // the eye should land on the same one.
      const cleanest = (r.cleanest as Record<string, unknown> | null)?.clock;
      for (const p of points) if (p.label === cleanest) p.highlight = true;
      return {
        kind: "hourly",
        title: `${String(r.location ?? "")} — the rest of today, hour by hour`,
        unit: unitFor(r.pollutant),
        points,
        note: modeNote(r.mode) ?? (typeof r.headline === "string" ? r.headline : null),
      };
    }

    case "forecast": {
      const days = Array.isArray(r.days) ? r.days : [];
      const points: ChartPoint[] = [];
      let anySeasonal = false;
      for (const d of days) {
        const row = d as Record<string, unknown>;
        const v = num(row.value);
        if (v === null) continue;
        if (row.mode === "seasonal_normal") anySeasonal = true;
        points.push({ label: String(row.date ?? row.target_date ?? ""), value: v });
      }
      if (points.length < 2) return null;   // two days is already a trend
      return {
        kind: "daily",
        title: `${String(r.location ?? "")} — the days ahead`,
        unit: unitFor(r.pollutant),
        points,
        note: anySeasonal
          ? "Days marked as seasonal normal are the seasonal average, not predictions."
          : null,
      };
    }

    case "history": {
      // `series` is carried by the tool purely so this can draw it; the model
      // answers from the mean/min/max alongside it.
      const series = Array.isArray(r.series) ? r.series : [];
      const points: ChartPoint[] = [];
      for (const d of series) {
        const row = d as Record<string, unknown>;
        const v = num(row.value ?? row.mean);
        if (v === null) continue;
        points.push({ label: String(row.date ?? ""), value: v });
      }
      if (points.length < MIN_POINTS) return null;
      return {
        kind: "history",
        title: `${String(r.location ?? "")} — what was measured`,
        unit: unitFor(r.pollutant),
        points,
        note: null,
      };
    }

    case "best_hour": {
      const hourly = Array.isArray(r.hourly) ? r.hourly : [];
      const points: ChartPoint[] = [];
      for (const h of hourly) {
        const row = h as Record<string, unknown>;
        const v = num(row.value);
        if (v === null) continue;
        points.push({ label: String(row.clock ?? row.hour ?? ""), value: v });
      }
      if (points.length < MIN_POINTS) return null;
      const cleanest = r.cleanest_clock;
      for (const p of points) if (p.label === cleanest) p.highlight = true;
      return {
        kind: "hourly",
        title: `${String(r.location ?? "")} — tomorrow, hour by hour`,
        unit: unitFor(r.pollutant),
        points,
        note: null,
      };
    }

    case "rank_places": {
      const all = Array.isArray(r.all) ? r.all : [];
      const points: ChartPoint[] = [];
      for (const x of all) {
        const row = x as Record<string, unknown>;
        const v = num(row.value);
        if (v === null) continue;
        // Station names carry the network suffix ("Worli, Mumbai - MPCB"),
        // which is noise on an axis label.
        const label = String(row.station ?? "").split(",")[0].trim();
        points.push({ label, value: v });
      }
      if (points.length < 2) return null;
      if (points[0]) points[0].highlight = true;   // the cleanest
      return {
        kind: "compare",
        title: `${String(r.location ?? "")} — cleanest to dirtiest today`,
        unit: unitFor(r.pollutant),
        points,
        note: typeof r.note === "string" ? r.note : null,
      };
    }

    case "compare": {
      // compare returns two named sides, a and b, not an array.
      const points: ChartPoint[] = [];
      for (const side of [r.a, r.b]) {
        const row = (side ?? {}) as Record<string, unknown>;
        const v = num(row.mean);
        if (v === null) continue;
        points.push({ label: String(row.location ?? ""), value: v });
      }
      if (points.length < 2) return null;
      return {
        kind: "compare",
        title: "Compared",
        unit: unitFor(r.pollutant),
        points,
        note: null,
      };
    }

    default:
      // current_aqi is a single fact. A chart of one value is decoration
      // pretending to be evidence.
      return null;
  }
}

/**
 * At most one chart per answer, and the richest available.
 *
 * Several tools may have run — "is Mumbai better than Delhi" calls current_aqi
 * twice — and stacking charts under a two-sentence answer buries it. Prefer
 * the one with the most to show.
 */
export function bestChart(results: { name: string; result: unknown }[]): AnswerChart | null {
  const charts = results
    .map((r) => chartFor(r.name, r.result))
    .filter((c): c is AnswerChart => c !== null);
  if (!charts.length) return null;
  return charts.sort((a, b) => b.points.length - a.points.length)[0];
}
