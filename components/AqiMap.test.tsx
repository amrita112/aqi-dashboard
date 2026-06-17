/**
 * Wiring tests for the AqiMap component.
 *
 * What these tests check: given certain props, does AqiMap pass the right
 * coordinates, colors, and radius to Leaflet's components?
 *
 * What these tests do NOT check: whether the map *visually* renders
 * correctly (tiles loading, pixel positions, etc.). Real Leaflet doesn't
 * run inside the fake browser (happy-dom), and even if it did, asserting
 * on pixels would need screenshot tests in a real browser. That's a job
 * for Playwright/Cypress in a future integration-test setup.
 *
 * The strategy: replace `react-leaflet` and `leaflet` with stubs.
 * The stubs are tiny components that render their props onto the DOM as
 * `data-*` attributes. Then we use Testing Library to query the DOM and
 * assert on those attributes — effectively "did AqiMap call CircleMarker
 * with the right arguments?"
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Reading } from "@/lib/types";

/**
 * Replace react-leaflet's components with stubs.
 * `vi.mock` is hoisted by Vitest to the top of the file before imports run,
 * so by the time AqiMap is imported, it sees these stubs instead of the
 * real Leaflet wrappers.
 *
 * Each stub renders a <div> with data-* attributes that mirror the props
 * we care about asserting on (center, radius, color, etc.).
 */
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children, center, zoom }: any) => (
    <div
      data-testid="map-container"
      data-center={JSON.stringify(center)}
      data-zoom={zoom}
    >
      {children}
    </div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
  CircleMarker: ({ children, center, radius, fillColor }: any) => (
    <div
      data-testid="circle-marker"
      data-center={JSON.stringify(center)}
      data-radius={radius}
      data-fill-color={fillColor}
    >
      {children}
    </div>
  ),
  Circle: ({ center, radius }: any) => (
    <div
      data-testid="selection-circle"
      data-center={JSON.stringify(center)}
      data-radius={radius}
    />
  ),
  Marker: ({ position }: any) => (
    <div
      data-testid="selection-marker"
      data-position={JSON.stringify(position)}
    />
  ),
  Popup: ({ children }: any) => <div data-testid="popup">{children}</div>,
  // The `useMap` and `useMapEvents` hooks are called by InitialFitBounds
  // and MapClickHandler. We return harmless stand-ins so those components
  // can render without errors.
  useMap: () => ({ fitBounds: vi.fn() }),
  useMapEvents: () => null,
}));

/**
 * Stub the `leaflet` library too — AqiMap reaches into it for `L.divIcon`
 * (to build the selection icon) and `L.DomEvent.stopPropagation` (inside
 * the marker click handler).
 */
vi.mock("leaflet", () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    DomEvent: { stopPropagation: vi.fn() },
  },
}));

// IMPORTANT: import AqiMap *after* the vi.mock calls above so it picks up
// the stubs. (vi.mock is hoisted, but keeping the import after is clearer.)
import AqiMap from "./AqiMap";

/** Helper: build a Reading with sensible defaults so each test only sets the bits it cares about. */
function makeReading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: "r1",
    user_id: "u1",
    aqi_value: 75,
    latitude: 28.6,
    longitude: 77.2,
    image_url: null,
    device_type: null,
    source: "user",
    recorded_at: "2026-04-01T00:00:00Z",
    created_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("AqiMap wiring", () => {
  it("renders one CircleMarker per reading at the correct coordinates", () => {
    const readings = [
      makeReading({ id: "a", latitude: 28.6, longitude: 77.2 }),   // Delhi
      makeReading({ id: "b", latitude: 19.07, longitude: 72.87 }), // Mumbai
      makeReading({ id: "c", latitude: 12.97, longitude: 77.59 }), // Bangalore
    ];

    const { getAllByTestId } = render(
      <AqiMap readings={readings} selectedLocation={null} />
    );

    const markers = getAllByTestId("circle-marker");
    expect(markers).toHaveLength(3);

    // Each marker's center should match the corresponding reading's lat/lng.
    expect(markers[0].dataset.center).toBe(JSON.stringify([28.6, 77.2]));
    expect(markers[1].dataset.center).toBe(JSON.stringify([19.07, 72.87]));
    expect(markers[2].dataset.center).toBe(JSON.stringify([12.97, 77.59]));
  });

  it("colors each marker by its AQI value (EPA scale)", () => {
    // Pick one reading from each EPA category so we can assert the color mapping.
    const readings = [
      makeReading({ id: "good",      aqi_value: 25  }),  // Good      → #00e400
      makeReading({ id: "moderate",  aqi_value: 75  }),  // Moderate  → #ffff00
      makeReading({ id: "hazardous", aqi_value: 400 }),  // Hazardous → #7e0023
    ];

    const { getAllByTestId } = render(
      <AqiMap readings={readings} selectedLocation={null} />
    );

    const markers = getAllByTestId("circle-marker");
    expect(markers[0].dataset.fillColor).toBe("#00e400");
    expect(markers[1].dataset.fillColor).toBe("#ffff00");
    expect(markers[2].dataset.fillColor).toBe("#7e0023");
  });

  it("draws no selection marker or radius circle when selectedLocation is null", () => {
    const { queryByTestId } = render(
      <AqiMap readings={[makeReading()]} selectedLocation={null} />
    );

    // queryByTestId returns null (instead of throwing) when nothing matches.
    expect(queryByTestId("selection-marker")).toBeNull();
    expect(queryByTestId("selection-circle")).toBeNull();
  });

  it("draws the selection marker and radius circle at the chosen coordinates", () => {
    const { getByTestId } = render(
      <AqiMap
        readings={[]}
        selectedLocation={{
          lat: 28.6139,
          lng: 77.2090,
          isStation: false,
          radiusMeters: 5000,
        }}
      />
    );

    expect(getByTestId("selection-marker").dataset.position).toBe(
      JSON.stringify([28.6139, 77.209])
    );

    const circle = getByTestId("selection-circle");
    expect(circle.dataset.center).toBe(JSON.stringify([28.6139, 77.209]));
    expect(circle.dataset.radius).toBe("5000");
  });

  it("passes coordinates through unchanged even at unusual values", () => {
    // Sanity check: AqiMap should not silently clamp or drop weird inputs.
    // Real Leaflet validates coordinates at render time in a real browser;
    // our component just forwards them. This protects against an accidental
    // future "if (lat > 90) return null" creeping in.
    const readings = [
      makeReading({ id: "south-pole", latitude: -89.9, longitude: 0 }),
      makeReading({ id: "antimeridian", latitude: 0, longitude: 179.9 }),
    ];

    const { getAllByTestId } = render(
      <AqiMap readings={readings} selectedLocation={null} />
    );

    const markers = getAllByTestId("circle-marker");
    expect(markers[0].dataset.center).toBe(JSON.stringify([-89.9, 0]));
    expect(markers[1].dataset.center).toBe(JSON.stringify([0, 179.9]));
  });
});
