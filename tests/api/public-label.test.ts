/**
 * Place names: the person's own (kept tidy and short) and the public ones the
 * app uses in anything shared (never built from the person's words).
 *
 * The rule being pinned: a shared Trends chart or message must not carry the
 * "Call this place" nickname. See lib/public-label.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  cleanPlaceLabel,
  areaFromStations,
  loadPrefs,
  savePrefs,
  MAX_PLACE_LABEL_CHARS,
} from "@/lib/prefs";
import { nearLabel, areaUnknownLabel, stationsNote, trendsShareText } from "@/lib/public-label";
import { myPlace, pointPlace, cityPlace } from "@/components/PlaceEditor";

beforeEach(() => window.localStorage.clear());

describe("cleanPlaceLabel", () => {
  it("turns line breaks and control characters into single spaces", () => {
    expect(cleanPlaceLabel("  Home\n\tsweet\u0000 home  ")).toBe("Home sweet home");
  });

  it("caps the length, cutting at a word where it can", () => {
    const long = "Bandra Kurla Complex, Bandra East, Mumbai, Maharashtra 400051";
    const out = cleanPlaceLabel(long);
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_PLACE_LABEL_CHARS);
    expect(out).toBe("Bandra Kurla Complex, Bandra East");
  });

  it("never splits a character in two", () => {
    const out = cleanPlaceLabel("घर".repeat(40));
    expect(Array.from(out).length).toBe(MAX_PLACE_LABEL_CHARS);
  });
});

describe("public labels", () => {
  it("names the nearest station's area and the city", () => {
    const area = areaFromStations([{ name: "Kherwadi_Bandra East, Mumbai - MPCB" }]);
    expect(area).toBe("Kherwadi, Bandra East");
    expect(nearLabel(area, "Mumbai")).toBe("Near Kherwadi, Bandra East, Mumbai");
  });

  it("does not repeat a city already in the area name", () => {
    expect(nearLabel("Mumbai Central", "Mumbai")).toBe("Near Mumbai Central");
  });

  it("falls back to the city, not to a nickname, when the area is unknown", () => {
    expect(nearLabel(undefined, "Pune")).toBe(areaUnknownLabel("Pune"));
    expect(areaFromStations([])).toBeUndefined();
  });

  it("says how many stations and how far, only when it knows", () => {
    expect(stationsNote(3, 2.06)).toBe("3 monitoring stations within 2.1 km");
    expect(stationsNote(1, undefined)).toBe("1 monitoring station");
    expect(stationsNote(0, 2)).toBeNull();
  });

  it("builds share text from public labels only", () => {
    const text = trendsShareText(
      "The air quality forecast",
      [
        { label: "Near Kherwadi, Bandra East, Mumbai", note: "3 monitoring stations within 2.1 km" },
        { label: "Delhi NCR (city average)" },
      ],
      "See the forecast for your area: https://airgyaan.in",
    );
    expect(text).toBe(
      "The air quality forecast, from AirGyaan — Near Kherwadi, Bandra East, Mumbai (3 monitoring stations within 2.1 km); Delhi NCR (city average). See the forecast for your area: https://airgyaan.in",
    );
  });
});

describe("Trends places keep the nickname on screen only", () => {
  const prefs = {
    version: 2 as const,
    city: "Mumbai",
    anchor: { monitor_id: "x", name: "Riya's school", area: "Kherwadi, Bandra East", latitude: 19, longitude: 72.8 },
    measurement: "aqi" as const,
    threshold: null,
    saved_at: "",
  };

  it("my place: label is the nickname, publicLabel is ours", () => {
    const pl = myPlace(prefs);
    expect(pl.label).toBe("Riya's school");
    expect(pl.publicLabel).toBe("Near Kherwadi, Bandra East, Mumbai");
  });

  it("an older install without an area has no public label yet (never the nickname)", () => {
    const { area: _drop, ...old } = prefs.anchor;
    void _drop;
    expect(myPlace({ ...prefs, anchor: old }).publicLabel).toBeNull();
  });

  it("a dropped pin uses the nearest station's area, not the typed name", () => {
    const pl = pointPlace(
      { city: "Pune", lat: 18.5, lng: 73.8 },
      { latitude: 18.55, longitude: 73.8, label: "My flat", stations: [{ name: "Karve Road, Pune - MPCB" }] },
    );
    expect(pl.label).toBe("Pune · My flat");
    expect(pl.publicLabel).toBe("Near Karve Road, Pune");
    expect(pl.publicLabel).not.toContain("My flat");
  });

  it("a city average is labelled the same everywhere", () => {
    const pl = cityPlace({ city: "Delhi NCR", lat: 28.6, lng: 77.2 });
    expect(pl.publicLabel).toBe(pl.label);
  });
});

describe("savePrefs applies the name rules", () => {
  it("cleans and caps the nickname and keeps the area", () => {
    savePrefs({
      city: "Mumbai",
      anchor: { monitor_id: "x", name: "Home\nline two " + "x".repeat(60), area: "Kherwadi, Bandra East", latitude: 19, longitude: 72.8 },
      measurement: "aqi",
      threshold: null,
    });
    const p = loadPrefs()!;
    expect(p.anchor.name).not.toMatch(/\n/);
    expect(Array.from(p.anchor.name).length).toBeLessThanOrEqual(MAX_PLACE_LABEL_CHARS);
    expect(p.anchor.area).toBe("Kherwadi, Bandra East");
  });

  it("an all-blank nickname falls back to the area", () => {
    savePrefs({
      city: "Mumbai",
      anchor: { monitor_id: "x", name: " \n ", area: "Kherwadi, Bandra East", latitude: 19, longitude: 72.8 },
      measurement: "aqi",
      threshold: null,
    });
    expect(loadPrefs()!.anchor.name).toBe("Kherwadi, Bandra East");
  });
});
