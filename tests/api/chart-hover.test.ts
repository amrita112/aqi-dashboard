/**
 * Which row is under the pointer.
 *
 * This is pinned because getting it wrong is silent. recharts reports
 * `activeTooltipIndex` as a STRING, and a check for `typeof index === "number"`
 * therefore matched nothing: the chart drew its cursor line and its active dot
 * from its own state, and the reading never appeared. Nothing threw, nothing
 * logged, and the bug read as "touch does not work" on a phone and went
 * unnoticed on a laptop.
 */

import { describe, it, expect } from "vitest";
import { hoveredIndex } from "@/lib/chart-hover";

describe("hoveredIndex", () => {
  it("accepts the string index recharts actually sends", () => {
    expect(hoveredIndex({ activeTooltipIndex: "3" }, 10)).toBe(3);
    expect(hoveredIndex({ activeTooltipIndex: "0" }, 10)).toBe(0);
    expect(hoveredIndex({ activeTooltipIndex: "9" }, 10)).toBe(9);
  });

  it("accepts a number too, in case a version sends one", () => {
    expect(hoveredIndex({ activeTooltipIndex: 4 }, 10)).toBe(4);
  });

  it("reports nothing when the pointer is off the data", () => {
    expect(hoveredIndex({ activeTooltipIndex: null }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: undefined }, 10)).toBeNull();
    expect(hoveredIndex({}, 10)).toBeNull();
    expect(hoveredIndex(undefined, 10)).toBeNull();
  });

  it("rejects an index outside the rows rather than reading undefined", () => {
    expect(hoveredIndex({ activeTooltipIndex: "10" }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: "-1" }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: "0" }, 0)).toBeNull();
  });

  it("rejects a label that is not a row number", () => {
    // A categorical chart can key its tooltip by label. Ours does not, but
    // "6am" must not be read as a position.
    expect(hoveredIndex({ activeTooltipIndex: "6am" }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: "" }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: "  " }, 10)).toBeNull();
    expect(hoveredIndex({ activeTooltipIndex: "2.5" }, 10)).toBeNull();
    // parseInt would have accepted this one as 3.
    expect(hoveredIndex({ activeTooltipIndex: "3px" }, 10)).toBeNull();
  });
});
