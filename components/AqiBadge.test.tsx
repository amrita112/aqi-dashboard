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
  it("renders the AQI value and its category label", () => {
    render(<AqiBadge value={75} />);

    // 75 is in the Moderate range (51–100). Both the number and the label
    // should be visible to the user.
    expect(screen.getByText("75")).toBeInTheDocument();
    expect(screen.getByText(/Moderate/)).toBeInTheDocument();
  });

  it("uses the EPA color for the category as the background", () => {
    // 400 is Hazardous → background should be the EPA maroon (#7e0023).
    const { container } = render(<AqiBadge value={400} />);
    const badge = container.querySelector("span");

    expect(badge).toHaveStyle({ backgroundColor: "#7e0023" });
  });
});
