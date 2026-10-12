/**
 * Which data row is under the pointer, from a recharts event.
 *
 * THIS EXISTS BECAUSE THE INDEX IS A STRING. recharts types
 * `activeTooltipIndex` as `TooltipIndex | null`, and `TooltipIndex` is
 * `string | null` — a categorical chart can key its tooltip by label rather
 * than by position, so the index is carried as text even when, as here, it is
 * really a row number.
 *
 * Code that checked `typeof index === "number"` therefore matched nothing and
 * silently reported no hovered point, on a mouse and on a finger alike: the
 * cursor line and the active dot appeared, because recharts draws those from
 * its own state, and no reading ever did. That looked like a touch-support
 * problem and was not one.
 *
 * One function, used by every chart that reports a hovered value, so the
 * parsing cannot be got right in one place and wrong in another.
 */

/** The row index under the pointer, or null if the pointer is off the data. */
export function hoveredIndex(
  state: { activeTooltipIndex?: number | string | null } | undefined,
  rowCount: number,
): number | null {
  const raw = state?.activeTooltipIndex;
  if (raw === null || raw === undefined) return null;

  // Number() rather than parseInt: parseInt("3px") is 3, which would accept a
  // label that merely starts with a digit. An empty string is also rejected,
  // where Number("") would be 0 — a real row.
  const i = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(i)) return null;

  // Bounds-checked here rather than by the caller: an index past the end reads
  // as undefined and quietly shows nothing, which is the same failure again.
  if (i < 0 || i >= rowCount) return null;
  return i;
}
