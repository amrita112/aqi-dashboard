/**
 * Source Filter — a row of toggle buttons for filtering readings by data source.
 *
 * Each button represents a data source (User Entries, OpenAQ, Government, Simulated).
 * Clicking a button toggles it on/off. The dashboard only shows readings from
 * sources that are currently toggled ON.
 *
 * All sources are ON by default.
 */
"use client";

import { DataSource, ALL_SOURCES, SOURCE_LABELS } from "@/lib/types";

/** Colors for each source — used for the indicator dot on each button */
const SOURCE_COLORS: Record<DataSource, string> = {
  user: "#3b82f6",       // Blue
  openaq: "#10b981",     // Green
  government: "#f59e0b", // Amber
  simulated: "#8b5cf6",  // Purple
};

interface SourceFilterProps {
  activeSources: DataSource[];                      // Which sources are currently toggled on
  onToggle: (source: DataSource) => void;           // Called when a button is clicked
}

export default function SourceFilter({ activeSources, onToggle }: SourceFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-gray-500 mr-1">Filter by source:</span>
      {ALL_SOURCES.map((source) => {
        const isActive = activeSources.includes(source);
        return (
          <button
            key={source}
            onClick={() => onToggle(source)}
            className={`
              inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
              border transition-colors
              ${isActive
                ? "bg-white border-gray-300 text-gray-800"
                : "bg-gray-100 border-gray-200 text-gray-400 line-through"
              }
            `}
          >
            {/* Colored dot — filled when active, hollow when inactive */}
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                backgroundColor: isActive ? SOURCE_COLORS[source] : "transparent",
                border: `2px solid ${SOURCE_COLORS[source]}`,
              }}
            />
            {SOURCE_LABELS[source]}
          </button>
        );
      })}
    </div>
  );
}
