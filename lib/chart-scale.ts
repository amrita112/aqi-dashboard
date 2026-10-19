/**
 * Round numbers on the y-axis.
 *
 * The charts pad their domain around the data — deliberately, because a
 * pollutant series anchored at zero draws a rising forecast as a flat line.
 * But handing recharts an arbitrary padded range let it divide that range into
 * five equal parts, which produced axes labelled 111 / 161 / 211 / 261 / 300
 * and 7 / 72 / 137 / 202 / 249. Those are readable only by reading them; the
 * eye cannot use them to estimate a value off the line, which is most of what
 * a y-axis is for.
 *
 * So pick a round STEP first — 1, 2, 2.5 or 5 times a power of ten, the steps
 * people actually count in — and let the domain follow from it.
 */

/** A padded, round-numbered scale covering `lo`..`hi`. */
export function niceScale(
  loInput: number,
  hi: number,
  { targetTicks = 5, allowNegative = false }: { targetTicks?: number; allowNegative?: boolean } = {},
): { domain: [number, number]; ticks: number[] } {
  // A flat series, a single point, or no data at all: give the caller
  // something drawable rather than NaN or a zero-width domain.
  let lo = loInput;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
  if (hi <= lo) {
    const v = Number.isFinite(lo) ? lo : 0;
    return niceScale(v - 1, v + 1, { targetTicks, allowNegative });
  }

  // CLAMP BEFORE CHOOSING THE STEP, not after. Callers pass an already-padded
  // range, so a series whose minimum is 13 arrives here as -0.9 — and a check
  // for "is the low end negative" then looked at the padding rather than at
  // the data. The axis came back starting at -50, spending a sixth of the
  // chart's height on concentrations that cannot exist.
  if (!allowNegative && lo < 0) lo = 0;

  const rawStep = (hi - lo) / Math.max(1, targetTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  // 2.5 earns its place: without it a range wanting a step near 2.5 gets 5,
  // which halves the number of gridlines and coarsens the whole axis.
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;

  let start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  if (!allowNegative && start < 0) start = 0;

  const ticks: number[] = [];
  // Floating-point steps (2.5, 0.1) accumulate error, so the guard is a
  // fraction of a step rather than an exact comparison, and each tick is
  // rounded to kill the 0.30000000000000004 tail.
  for (let v = start; v <= end + step / 1000; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { domain: [start, end], ticks };
}

/**
 * A TIGHT scale: the axis ends just past the data, and the round numbers are
 * the TICKS rather than the ends.
 *
 * niceScale snaps both ends of the axis out to the next round step, and with a
 * step of 50 that could spend a third of the chart on nothing — a 24-hour
 * forecast running 25 to 100 was drawn on 0 to 150. Amrita asked for more of
 * the variation to be visible. Here the domain is the data plus a small pad,
 * and round ticks are placed wherever they fall inside it; the axis may begin
 * at 21 and end at 104, which reads fine because nobody reads the end of an
 * axis, they read the labelled lines.
 */
export function tightScale(
  lo: number,
  hi: number,
  { padShare = 0.06, minPad = 2, targetTicks = 5 }: { padShare?: number; minPad?: number; targetTicks?: number } = {},
): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
  // A flat series: open a small window around it so the line has somewhere to sit.
  if (hi <= lo) return tightScale(lo - Math.max(1, Math.abs(lo) * 0.1), hi + Math.max(1, Math.abs(hi) * 0.1), { padShare, minPad, targetTicks });

  const pad = Math.max(minPad, (hi - lo) * padShare);
  // Concentrations and AQI cannot be negative; no height is spent below zero.
  const dLo = Math.max(0, lo - pad);
  const dHi = hi + pad;

  // The same round steps as niceScale, chosen so roughly targetTicks fall inside.
  const rawStep = (dHi - dLo) / Math.max(1, targetTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;

  const ticks: number[] = [];
  for (let v = Math.ceil(dLo / step) * step; v <= dHi + step / 1000; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  // Rounded to one decimal so a domain end never prints as 104.49999999.
  return { domain: [Math.round(dLo * 10) / 10, Math.round(dHi * 10) / 10], ticks };
}
