/**
 * The Trends tab's "these two places use the same monitoring stations" check
 * (lib/same-stations.ts).
 */
import { describe, it, expect } from "vitest";
import { sameStationSet, sameStationsMessage, stationIdsOf, PETITION_PATH } from "@/lib/same-stations";

describe("sameStationSet", () => {
  it("same ids in a different order are the same set", () => {
    expect(sameStationSet(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  it("one station different is a different set", () => {
    expect(sameStationSet(["a", "b", "c"], ["a", "b", "d"])).toBe(false);
  });

  it("a subset is not the same set (a city's 10 against a neighbourhood's 3)", () => {
    expect(sameStationSet(["a", "b", "c"], ["a", "b", "c", "d", "e"])).toBe(false);
    expect(sameStationSet(["a", "b", "c", "d"], ["a", "b"])).toBe(false);
  });

  it("repeats are ignored", () => {
    expect(sameStationSet(["a", "a", "b"], ["b", "a"])).toBe(true);
  });

  it("unknown or empty lists are never the same", () => {
    expect(sameStationSet(null, ["a"])).toBe(false);
    expect(sameStationSet(["a"], undefined)).toBe(false);
    expect(sameStationSet([], [])).toBe(false);
  });
});

describe("stationIdsOf", () => {
  it("reads monitor ids from a response's meta.stations", () => {
    expect(stationIdsOf({ stations: [{ monitor_id: "x" }, { monitor_id: "y" }] })).toEqual(["x", "y"]);
  });
  it("null when there is nothing to read", () => {
    expect(stationIdsOf(null)).toBeNull();
    expect(stationIdsOf({ stations: [] })).toBeNull();
    expect(stationIdsOf({})).toBeNull();
  });
});

describe("sameStationsMessage", () => {
  it("says how many monitoring stations, singular and plural", () => {
    expect(sameStationsMessage(3)).toContain("both use the same 3 monitoring stations.");
    expect(sameStationsMessage(1)).toContain("both use the same monitoring station.");
  });
  it("the link goes to the petition page", () => {
    expect(PETITION_PATH).toBe("/petition");
  });
});
