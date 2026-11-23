/**
 * "Are these two places really the same place?" -- for the Trends tab's
 * comparisons.
 *
 * WHY. Every answer about a place is an average of the monitoring stations
 * nearest it (three, for a neighbourhood). Two places a few hundred metres
 * apart usually have the same three nearest stations, so their lines are
 * identical, drawn one on top of the other. Shown as two lines, that looks
 * like a finding ("the air is the same in both places") when it is only the
 * network being too sparse to tell them apart. So when the two places'
 * stations are EXACTLY the same set, the Trends cards draw one line and say
 * why, pointing at the petition for denser measurement.
 *
 * Each card compares the stations its OWN answer was built from (the
 * `meta.stations` of the forecast or history response, or the climate
 * answer's monitor_ids), because that is exactly when its two lines would be
 * identical. A city average and a neighbourhood inside it normally differ
 * (every station in the city against 3), so they are compared as usual.
 *
 * Pure (no browser, no network), so it is tested directly in
 * tests/api/same-stations.test.ts.
 */

/** Where the warning's link goes: the petition page (app/petition). */
export const PETITION_PATH = "/petition";

/** The words that become the link at the end of the warning. */
export const SAME_STATIONS_LINK_TEXT = "sign the petition";

/**
 * The warning, up to the link. Kept here as one constant so the wording can
 * change in one place. `count` is how many monitoring stations both use.
 */
export function sameStationsMessage(count: number): string {
  const which = count === 1 ? "monitoring station" : `${count} monitoring stations`;
  return (
    `These two places are too close together to tell apart: both use the same ${which}. ` +
    "Hyperlocal measurement would need more monitoring stations —"
  );
}

/**
 * True when both lists are non-empty and hold exactly the same station ids,
 * in any order (repeats ignored). An unknown or empty list is never "the
 * same": no answer yet is not evidence that two places coincide.
 */
export function sameStationSet(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a?.length || !b?.length) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of Array.from(sa)) if (!sb.has(id)) return false;
  return true;
}

/** The station ids in a response's `meta.stations` list (placeMeta), or null. */
export function stationIdsOf(
  meta: { stations?: { monitor_id?: string }[] } | null | undefined,
): string[] | null {
  const ids = (meta?.stations ?? [])
    .map((s) => s.monitor_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length ? ids : null;
}
