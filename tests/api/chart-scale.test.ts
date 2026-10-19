/**
 * Round numbers on the y-axis.
 *
 * Pinned because the failure is cosmetic and therefore easy to reintroduce:
 * an axis labelled 111 / 161 / 211 / 261 / 300 is not wrong, it is just
 * unusable for estimating a value off the line.
 */

import { describe, it, expect } from "vitest";
import { niceScale, tightScale } from "@/lib/chart-scale";

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

describe("padded callers", () => {
  it("does not go negative when a caller pads a non-negative series", () => {
    // The bug: callers pass niceScale(lo - pad, hi + pad), so a series whose
    // minimum was 13 arrived as -0.9 and the axis came back starting at -50.
    const lo = 13;
    const hi = 90;
    const pad = Math.max(5, (hi - lo) * 0.18);
    const { domain, ticks } = niceScale(lo - pad, hi + pad);
    expect(domain[0]).toBe(0);
    expect(ticks.every((t) => t >= 0)).toBe(true);
  });
});

describe("tightScale", () => {
  it("does not leave a third of the chart empty (the 24-hour forecast at 25-100)", () => {
    const { domain, ticks } = tightScale(25, 100);
    // niceScale put this on 0-150. The axis now ends just past the data.
    expect(domain[0]).toBeGreaterThan(15);
    expect(domain[1]).toBeLessThan(110);
    expect(ticks).toEqual([25, 50, 75, 100]);
  });

  it("covers the whole data range", () => {
    const { domain } = tightScale(7, 249);
    expect(domain[0]).toBeLessThanOrEqual(7);
    expect(domain[1]).toBeGreaterThanOrEqual(249);
  });

  it("puts every tick inside the domain, and at least two of them", () => {
    for (const [lo, hi] of [[25, 100], [13, 90], [140, 160], [0.5, 3], [200, 480]]) {
      const { domain, ticks } = tightScale(lo, hi);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(domain[0]);
        expect(t).toBeLessThanOrEqual(domain[1]);
      }
    }
  });

  it("never dips below zero", () => {
    expect(tightScale(1, 40).domain[0]).toBe(0);
  });

  it("gives a drawable scale for a flat series and for no data", () => {
    const flat = tightScale(50, 50);
    expect(flat.domain[1]).toBeGreaterThan(flat.domain[0]);
    const empty = tightScale(Infinity, -Infinity);
    expect(empty.domain.every(Number.isFinite)).toBe(true);
  });
});
