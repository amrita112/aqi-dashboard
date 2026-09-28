/**
 * The staleness disclosure, and the two things a user can do about it.
 *
 * The product's most honest moment, so it is pinned:
 *   - it never claims data is live when it is not
 *   - it says WHY a forecast fell back to a seasonal average
 *   - it never implies the user did something wrong
 *   - it never promises a V2 capability as if it worked today
 */

import { describe, it, expect } from "vitest";
import { assessDataQuality } from "@/lib/api/data-quality";

describe("levels", () => {
  it("calls only genuinely fresh data live, and then asks nothing of the user", () => {
    const q = assessDataQuality(2);
    expect(q.level).toBe("live");
    // Someone already well served should not be nudged.
    expect(q.actions).toHaveLength(0);
  });

  it("does not call a day-old reading live", () => {
    expect(assessDataQuality(20).level).toBe("recent");
  });

  it("escalates past a day, and only past ten days calls a monitor silent", () => {
    expect(assessDataQuality(40).level).toBe("stale");
    // Delhi's median is 3.9 days and Bengaluru's is 9.2 — the normal case,
    // not a failure, so neither may trip the harsher wording.
    expect(assessDataQuality(24 * 3.9).level).toBe("stale");
    expect(assessDataQuality(24 * 9.2).level).toBe("stale");
    expect(assessDataQuality(24 * 14).level).toBe("very_stale");
  });

  it("treats no reading at all as the worst case without crashing", () => {
    const q = assessDataQuality(null);
    expect(q.level).toBe("very_stale");
    expect(q.headline).toMatch(/no recent measurement/i);
    expect(Number.isFinite(q.age_days)).toBe(true);
  });
});

describe("wording", () => {
  it("states the age in days a person would actually say", () => {
    // 3.9 days is the measured Delhi median, so this is the common case.
    expect(assessDataQuality(24 * 3.9).headline).toMatch(/last reported 4 days ago/);
    expect(assessDataQuality(24 * 1.2).headline).toMatch(/1 day ago/);
  });

  it("explains a seasonal-average fallback by its actual cause", () => {
    const q = assessDataQuality(24 * 4, { servingSeasonalNormal: true });
    expect(q.affects_forecast).toBe(true);
    expect(q.explanation).toMatch(/seasonal average/i);
    expect(q.explanation).not.toMatch(/forecast for tomorrow/i);
  });

  it("does not blame the user anywhere", () => {
    for (const hours of [2, 20, 40, 24 * 10]) {
      const q = assessDataQuality(hours);
      const text = `${q.headline} ${q.explanation} ${q.actions.map((a) => a.body).join(" ")}`;
      expect(text).not.toMatch(/\byou (?:should|must|failed|need to)\b/i);
      expect(text).not.toMatch(/sorry|apologi/i);
    }
  });
});

describe("calls to action", () => {
  it("describes a typical 4-day lag as a delay, not a dead monitor", () => {
    const q = assessDataQuality(24 * 3.9);
    expect(q.explanation).toMatch(/republished on a delay/i);
    expect(q.headline).not.toMatch(/no monitor/i);
  });

  it("offers both routes once the data is properly stale", () => {
    const ids = assessDataQuality(24 * 4).actions.map((a) => a.id);
    expect(ids).toEqual(["connect_monitor", "support_hyperlocal"]);
  });

  it("labels connecting your own monitor as not yet available", () => {
    // It is a V2 capability. Promising it today would be a lie the UI could
    // not keep.
    const connect = assessDataQuality(24 * 4).actions.find((a) => a.id === "connect_monitor")!;
    expect(connect.available).toBe(false);
    expect(connect.body).toMatch(/next version/i);
  });

  it("offers the petition as something available now", () => {
    const support = assessDataQuality(24 * 4).actions.find((a) => a.id === "support_hyperlocal")!;
    expect(support.available).toBe(true);
  });

  it("ranks connecting a monitor above the petition", () => {
    // It is the one that actually fixes this user's data.
    const actions = assessDataQuality(24 * 4).actions;
    expect(actions[0].priority).toBeLessThan(actions[1].priority);
  });

  it("asks for support but not a purchase when only mildly behind", () => {
    const ids = assessDataQuality(20).actions.map((a) => a.id);
    expect(ids).toEqual(["support_hyperlocal"]);
  });
});
