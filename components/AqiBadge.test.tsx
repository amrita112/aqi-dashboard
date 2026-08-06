/**
 * Smoke test for the AqiBadge component.
 *
 * Renders the badge with a sample AQI value and asserts that:
 *   - the value and category label appear in the DOM
 *   - the background color matches the EPA color for that category
 *
 * This serves as the template for future component tests.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AqiBadge from "./AqiBadge";

describe("AqiBadge", () => {
  it("renders the AQI value and its category label (NAQI default)", () => {
    render(<AqiBadge value={75} />);

    // 75 falls in NAQI Satisfactory (51–100). Both number and label
    // should be visible to the user.
    expect(screen.getByText("75")).toBeInTheDocument();
    expect(screen.getByText(/Satisfactory/)).toBeInTheDocument();
  });

  it("uses the NAQI color for the category as the background", () => {
    // 450 is in NAQI Severe (401–1000) → background should be maroon (#7e0023).
    const { container } = render(<AqiBadge value={450} />);
    const badge = container.querySelector("span");

    expect(badge).toHaveStyle({ backgroundColor: "#7e0023" });
  });
});
