/**
 * Finding a place by name or PIN code.
 *
 * This exists because all three of the first testers struggled with the same
 * screen: finding their own home on a map of a city they only half recognise,
 * through a phone-sized window. The search box is the fix, and these pin the
 * parts of it that decide what someone actually sees in the list.
 */

import { describe, it, expect } from "vitest";
import { PIN, dedupe, distanceKm, tidyStationName, type GeocodeHit } from "@/lib/api/geocode";

const station = (label: string, latitude: number, longitude: number): GeocodeHit => ({
  label, latitude, longitude, kind: "station",
});
const place = (label: string, latitude: number, longitude: number): GeocodeHit => ({
  label, latitude, longitude, kind: "place",
});

describe("PIN codes", () => {
  it("accepts a real six-digit code", () => {
    for (const p of ["400051", "110001", "560001"]) expect(PIN.test(p)).toBe(true);
  });

  it("rejects what is not one", () => {
    // Leading zero is not an Indian PIN; the rest are lengths or words.
    for (const p of ["040051", "40005", "4000511", "Bandra", "400 051", ""]) {
      expect(PIN.test(p), p).toBe(false);
    }
  });
});

describe("station names people recognise", () => {
  it("strips the network and the city, and the underscore", () => {
    expect(tidyStationName("Kherwadi_Bandra East, Mumbai - MPCB")).toBe("Kherwadi, Bandra East");
    expect(tidyStationName("Bandra Kurla Complex, Mumbai - IITM")).toBe("Bandra Kurla Complex");
    expect(tidyStationName("Mindspace-Malad West, Mumbai - MPCB")).toBe("Mindspace-Malad West");
  });

  it("leaves a plain name alone", () => {
    expect(tidyStationName("Sewri")).toBe("Sewri");
  });
});

describe("dedupe", () => {
  it("collapses the same name twice, however far apart", () => {
    // Two instruments called "Bandra Kurla Complex" 350m apart were showing as
    // two identical rows, which reads as a broken list.
    const out = dedupe(
      [station("Bandra Kurla Complex", 19.0659, 72.8621),
       station("Bandra Kurla Complex", 19.0627, 72.8461)],
      6,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps two different names that happen to be close", () => {
    // The real failure: "Kherwadi, Bandra East" sits 70m from a BKC station
    // and was being dropped — the only name in the list someone from Bandra
    // would recognise.
    const out = dedupe(
      [station("Bandra Kurla Complex", 19.0627, 72.84614),
       station("Kherwadi, Bandra East", 19.0632143, 72.8456324)],
      6,
    );
    expect(out.map((h) => h.label)).toEqual(["Bandra Kurla Complex", "Kherwadi, Bandra East"]);
  });

  it("still collapses an external result onto a station at the same spot", () => {
    // Different sources name the same place differently, so position is what
    // identifies it across them.
    const out = dedupe(
      [station("Sewri", 19.0001, 72.8567), place("Sewri, F/S Ward, Mumbai", 19.0001, 72.8567)],
      6,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("station");
  });

  it("honours the result cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => station(`Place ${i}`, 19 + i / 100, 72));
    expect(dedupe(many, 6)).toHaveLength(6);
  });
});

describe("distanceKm", () => {
  it("is zero for the same point", () => {
    expect(distanceKm(19.076, 72.877, 19.076, 72.877)).toBeCloseTo(0, 6);
  });

  it("gets Mumbai to Delhi about right", () => {
    // ~1150 km. The filter that keeps a Pune "Nagar" out of a Mumbai search
    // depends on this being roughly true.
    expect(distanceKm(19.076, 72.877, 28.614, 77.209)).toBeGreaterThan(1100);
    expect(distanceKm(19.076, 72.877, 28.614, 77.209)).toBeLessThan(1200);
  });
});
