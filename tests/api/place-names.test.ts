/**
 * The app's place-matching rule must agree exactly with the alert job's
 * (scripts/alerts/place_names.py), on the same cases file. If this fails
 * after editing lib/place-aliases.json, update `key`/`groups` in
 * tests/fixtures/place_names/cases.json -- and pytest will check Python
 * agrees with the new values too.
 */
import { describe, expect, it } from "vitest";
import cases from "../fixtures/place_names/cases.json";
import { basicPlace, canonicalPlace, loadAliases, placeKeyGroup } from "@/lib/place-names";

describe("place names, shared with scripts/alerts/place_names.py", () => {
  for (const c of cases.cases) {
    it(`${JSON.stringify(c.typed)} -> ${JSON.stringify(c.key)}`, () => {
      expect(basicPlace(c.typed)).toBe(c.basic);
      expect(canonicalPlace(c.typed)).toBe(c.key);
    });
  }

  it("groups every spelling of a place, as the count needs", () => {
    for (const [canonical, group] of Object.entries(cases.groups)) {
      expect(placeKeyGroup(canonical)).toEqual(group);
    }
    // Any spelling in the group gives the whole group.
    expect(placeKeyGroup("Berhampur, Odisha")).toEqual(cases.groups.brahmapur);
  });

  it("gives no keys for a name with nothing left", () => {
    expect(placeKeyGroup(",,,")).toEqual([]);
  });

  it("rejects an alias chain, as the Python loader does", () => {
    expect(() => loadAliases({ aliases: { a: "b", b: "c" } })).toThrow(/canonical/);
  });
});
