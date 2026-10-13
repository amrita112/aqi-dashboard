"use client";

/**
 * A two-line x-axis tick: the clock on top, the date underneath.
 *
 * WHY NOT TWO <XAxis> ELEMENTS, which is the obvious way. recharts stacks
 * multiple bottom axes in its own order, and it put the date tier nearest the
 * plot with the hour tier below it — then clipped the hour tier in half at the
 * card's edge, because the chart's height had been budgeted for one axis. The
 * order could not be forced from the declaration order, and the clipping would
 * have needed every caller to know how tall its axis was.
 *
 * One axis drawing two lines of text has neither problem: nothing to stack,
 * and the height is declared once, here, by whoever renders it.
 *
 * Dates always sit on the LOWER line, even at a tick that has no hour above
 * it, so the dates across a chart line up with each other instead of stepping
 * up and down as their hours come and go.
 */

import type { ReactElement } from "react";

const HOUR_FILL = "#8b959b";
const DATE_FILL = "#5c6b73";

/** Axis height to reserve, in px. Pass the same `showHours` as to the tick. */
export function tickHeight(showHours: boolean): number {
  return showHours ? 32 : 18;
}

interface TickProps {
  // recharts types these as string | number — an axis can be positioned with
  // either — so they are coerced below rather than assumed numeric.
  x?: number | string;
  y?: number | string;
  payload?: { value?: number | string };
}

/**
 * Build the tick renderer.
 *
 * `labelsAt` answers, for a row index, what belongs on each line — either or
 * both may be empty.
 */
export function twoTierTick(
  labelsAt: (index: number) => { hour?: string; date?: string },
  showHours: boolean,
): (props: TickProps) => ReactElement {
  const dateDy = showHours ? 26 : 13;

  return function Tick({ x = 0, y = 0, payload }: TickProps) {
    const raw = payload?.value;
    const index = typeof raw === "number" ? raw : Number(raw);
    const { hour, date } = Number.isFinite(index) ? labelsAt(index) : {};

    return (
      <g transform={`translate(${Number(x) || 0},${Number(y) || 0})`}>
        {showHours && hour ? (
          <text dy={12} textAnchor="middle" fontSize={10} fill={HOUR_FILL}>
            {hour}
          </text>
        ) : null}
        {date ? (
          <text dy={dateDy} textAnchor="middle" fontSize={11} fill={DATE_FILL}>
            {date}
          </text>
        ) : null}
      </g>
    );
  };
}
