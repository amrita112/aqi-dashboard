/**
 * Round numbers on the y-axis.
 *
 * Pinned because the failure is cosmetic and therefore easy to reintroduce:
 * an axis labelled 111 / 161 / 211 / 261 / 300 is not wrong, it is just
 * unusable for estimating a value off the line.
 */

import { describe, it, expect } from "vitest";
import { niceScale } from "@/lib/chart-scale";

describe("niceScale", () => {
  it("produces round ticks for the range that produced 111/161/211", () => {
    const { ticks } = niceScale(111, 300);
    expect(ticks).toEqual([100, 150, 200, 250, 300]);
  });

  it("covers the whole data range", () => {
    const { domain } = niceScale(7, 249);
    expect(domain[0]).toBeLessThanOrEqual(7);
    expect(domain[1]).toBeGreaterThanOrEqual(249);
  });

  it("never dips below zero for data that cannot", () => {
    // Concentrations are non-negative; height spent below zero is wasted.
    const { domain } = niceScale(2, 40);
    expect(domain[0]).toBe(0);
  });

  it("allows negatives when the data really is negative", () => {
    const { domain } = niceScale(-30, 40, { allowNegative: true });
    expect(domain[0]).toBeLessThan(0);
  });

  it("gives a drawable scale for a flat series", () => {
    const { domain, ticks } = niceScale(50, 50);
    expect(domain[1]).toBeGreaterThan(domain[0]);
    expect(ticks.length).toBeGreaterThan(1);
  });

  it("survives empty data without producing NaN", () => {
    const { domain, ticks } = niceScale(Infinity, -Infinity);
    expect(domain.every(Number.isFinite)).toBe(true);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });

  it("does not leave floating-point tails on fractional steps", () => {
    const { ticks } = niceScale(0, 1);
    for (const t of ticks) expect(String(t)).not.toMatch(/\d{6,}/);
  });
});
