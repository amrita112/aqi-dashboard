/**
 * The six bands, in whatever the reader is looking at.
 *
 * This exists because of a specific doubt: a tester saw PM2.5 52 labelled
 * "Satisfactory" in green and did not believe it. CPCB does put 30-60 µg/m³
 * in that band, and the legend is there so nobody has to take it on trust.
 *
 * The failure mode worth pinning is showing AQI points beside a PM2.5
 * reading. 0-50 / 51-100 are index values; the PM2.5 boundaries are
 * 30 / 60 / 90 / 120 / 250, and printing the wrong pair would be confidently
 * wrong rather than merely unhelpful.
 */

import { describe, it, expect } from "vitest";
import { bandsFor } from "@/components/BandLegend";

describe("bandsFor", () => {
  it("gives AQI index points for the AQI scale", () => {
    const b = bandsFor("aqi");
    expect(b.map((x) => x.label)).toEqual([
      "Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe",
    ]);
    expect(b[0].to).toBe(50);
    expect(b[1].from).toBe(51);
  });

  it("gives concentrations for PM2.5, not index points", () => {
    const b = bandsFor("pm25");
    expect(b[0].to).toBe(30);
    expect(b[1].from).toBe(30);
    expect(b[1].to).toBe(60);
    expect(b[2].to).toBe(90);
  });

  it("puts 52 µg/m³ in Satisfactory, which is the thing that was doubted", () => {
    const b = bandsFor("pm25");
    const hit = b.find((x) => 52 >= x.from && (x.to === null || 52 < x.to));
    expect(hit?.label).toBe("Satisfactory");
  });

  it("leaves the top band open-ended on both scales", () => {
    expect(bandsFor("aqi").at(-1)?.to).toBeNull();
    expect(bandsFor("pm25").at(-1)?.to).toBeNull();
  });
});
