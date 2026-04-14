/**
 * AQI utility functions.
 * Maps AQI values to EPA categories, colors, and labels.
 * The EPA scale goes from 0 (best) to 500 (worst).
 */

import { AqiCategory } from "./types";

/**
 * The six EPA AQI categories.
 * Each has a range, a human-readable label, and a color.
 * Colors follow the standard EPA color scheme used on most AQI apps.
 */
const AQI_CATEGORIES: AqiCategory[] = [
  { label: "Good",                        color: "#00e400", min: 0,   max: 50  },
  { label: "Moderate",                     color: "#ffff00", min: 51,  max: 100 },
  { label: "Unhealthy for Sensitive Groups", color: "#ff7e00", min: 101, max: 150 },
  { label: "Unhealthy",                    color: "#ff0000", min: 151, max: 200 },
  { label: "Very Unhealthy",               color: "#8f3f97", min: 201, max: 300 },
  { label: "Hazardous",                    color: "#7e0023", min: 301, max: 500 },
];

/**
 * Given an AQI value (0–500), returns the matching EPA category.
 * For example: getAqiCategory(75) returns { label: "Moderate", color: "#ffff00", ... }
 */
export function getAqiCategory(value: number): AqiCategory {
  // Find the first category where the value falls within the min–max range
  const category = AQI_CATEGORIES.find(
    (cat) => value >= cat.min && value <= cat.max
  );
  // If the value is out of range (shouldn't happen with valid data), default to Hazardous
  return category ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1];
}

/**
 * Returns the color string for a given AQI value.
 * Useful for coloring map markers and badges.
 */
export function getAqiColor(value: number): string {
  return getAqiCategory(value).color;
}

/**
 * Returns the text label for a given AQI value.
 * For example: getAqiLabel(350) returns "Hazardous"
 */
export function getAqiLabel(value: number): string {
  return getAqiCategory(value).label;
}

/**
 * Returns a text color (black or white) that contrasts well with the AQI category color.
 * This makes sure text is readable when placed on a colored background.
 * Dark backgrounds get white text; light backgrounds get black text.
 */
export function getAqiTextColor(value: number): string {
  // These categories have dark backgrounds, so use white text
  const darkCategories = ["Unhealthy", "Very Unhealthy", "Hazardous"];
  return darkCategories.includes(getAqiLabel(value)) ? "#ffffff" : "#000000";
}
