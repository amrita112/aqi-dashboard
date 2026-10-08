/**
 * The three answers from first run, and where they live.
 *
 * Preferences sit in localStorage rather than a database because there are no
 * accounts in v1. That makes two failure modes worth pinning: storage that
 * throws (private windows, blocked site data) must not take the app down, and
 * a stored object from an older shape must be discarded rather than half-read.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadPrefs,
  savePrefs,
  clearPrefs,
  placeQuery,
  PREFS_KEY,
  NEAREST_K,
  MEASUREMENT_COPY,
  type Prefs,
} from "@/lib/prefs";

const VALID = {
  city: "Delhi NCR",
  anchor: {
    monitor_id: "11111111-1111-1111-1111-111111111111",
    name: "Alipur, Delhi - DPCC",
    latitude: 28.815329,
    longitude: 77.15301,
  },
  measurement: "aqi" as const,
  threshold: 380,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("round trip", () => {
  it("saves and reloads the three answers", () => {
    savePrefs(VALID);
    const back = loadPrefs()!;
    expect(back.city).toBe("Delhi NCR");
    expect(back.measurement).toBe("aqi");
    expect(back.threshold).toBe(380);
    expect(back.anchor.name).toBe("Alipur, Delhi - DPCC");
    expect(back.version).toBe(2);
  });

  it("keeps 'do not notify me' as an explicit null, not a missing value", () => {
    // The difference matters: null is a choice, undefined is an unanswered
    // question, and the threshold screen must not re-prompt someone who said no.
    savePrefs({ ...VALID, threshold: null });
    expect(loadPrefs()!.threshold).toBeNull();
  });

  it("returns null before anything is stored", () => {
    expect(loadPrefs()).toBeNull();
  });

  it("forgets on clear", () => {
    savePrefs(VALID);
    clearPrefs();
    expect(loadPrefs()).toBeNull();
  });
});

describe("bad stored data", () => {
  it("discards an object from an older shape rather than half-reading it", () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ version: 0, city: "Delhi NCR" }));
    expect(loadPrefs()).toBeNull();
  });

  it("discards a record missing its anchor", () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ version: 1, city: "Mumbai" }));
    expect(loadPrefs()).toBeNull();
  });

  it("survives unparseable JSON", () => {
    window.localStorage.setItem(PREFS_KEY, "{not json");
    expect(() => loadPrefs()).not.toThrow();
    expect(loadPrefs()).toBeNull();
  });
});

describe("storage that refuses", () => {
  /**
   * Swap window.localStorage for one that throws, then put it back.
   *
   * The whole object has to be replaced. happy-dom's Storage is a Proxy that
   * turns property assignment into storage ENTRIES, so `storage.getItem = fn`
   * quietly writes a key called "getItem" instead of overriding the method —
   * which is why both earlier attempts here silently tested nothing.
   */
  function whileStorageThrows(run: () => void) {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: access to storage is denied");
      },
    });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  }

  it("opens anyway when storage is unavailable", () => {
    // A private window, or site data blocked, throws on access rather than
    // returning null. Someone checking the air on a shared phone must not get
    // a blank screen for it.
    whileStorageThrows(() => {
      expect(() => loadPrefs()).not.toThrow();
      expect(loadPrefs()).toBeNull();
    });
  });

  it("reports a failed save rather than pretending it worked", () => {
    whileStorageThrows(() => {
      // null means "this will not survive a reload". The caller can still run
      // the session on the object it passed in.
      expect(() => savePrefs(VALID)).not.toThrow();
      expect(savePrefs(VALID)).toBeNull();
    });
  });

  it("still works once storage comes back", () => {
    whileStorageThrows(() => savePrefs(VALID));
    savePrefs(VALID);
    expect(loadPrefs()?.city).toBe("Delhi NCR");
  });
});

describe("placeQuery", () => {
  it("asks about a neighbourhood, not a single monitor", () => {
    savePrefs(VALID);
    const q = new URLSearchParams(placeQuery(loadPrefs() as Prefs));
    expect(q.get("lat")).toBe("28.815329");
    expect(q.get("lng")).toBe("77.15301");
    expect(q.get("k")).toBe(String(NEAREST_K));
    // Never the anchor's monitor_id: that would pin the answer to one station
    // and lose the averaging the anchor exists to centre.
    expect(q.get("monitor_id")).toBeNull();
  });

  it("carries extra parameters through", () => {
    savePrefs(VALID);
    const q = new URLSearchParams(placeQuery(loadPrefs() as Prefs, { pollutant: "pm25", days: 1 }));
    expect(q.get("pollutant")).toBe("pm25");
    expect(q.get("days")).toBe("1");
  });
});

describe("the explanation shown at first run", () => {
  it("tells people AQI is usually driven by PM10, which is the surprising part", () => {
    expect(MEASUREMENT_COPY.aqi.blurb).toMatch(/PM10/);
    // Wording changed in the 7 Oct review; the thing being asserted did not —
    // the PM2.5 explanation must name the particles and say why they matter.
    expect(MEASUREMENT_COPY.pm25.blurb).toMatch(/fine particulate|fine particles/i);
    expect(MEASUREMENT_COPY.pm25.blurb).toMatch(/lung/i);
  });

  it("gives PM2.5 a unit and AQI none, because AQI is an index", () => {
    expect(MEASUREMENT_COPY.pm25.unit).toBe("µg/m³");
    expect(MEASUREMENT_COPY.aqi.unit).toBe("");
  });
});
