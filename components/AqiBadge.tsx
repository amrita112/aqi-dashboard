/**
 * AQI Badge — a small colored label that shows an AQI value.
 *
 * Displays the number and its EPA category (e.g., "Good", "Hazardous")
 * on a color-coded background. Used on map popups, reading lists, etc.
 */

import { getAqiCategory, getAqiTextColor } from "@/lib/aqi-utils";

interface AqiBadgeProps {
  value: number;  // The AQI number (0–500)
}

export default function AqiBadge({ value }: AqiBadgeProps) {
  const category = getAqiCategory(value);
  const textColor = getAqiTextColor(value);

  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium"
      style={{ backgroundColor: category.color, color: textColor }}
    >
      {/* The AQI number */}
      <span className="font-bold">{value}</span>
      {/* The category label */}
      <span>— {category.label}</span>
    </span>
  );
}
