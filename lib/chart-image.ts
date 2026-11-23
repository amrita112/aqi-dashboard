/**
 * A chart on screen, as a PNG to share.
 *
 * WHY THE TITLE AND FOOTER ARE DRAWN HERE, NOT CAPTURED. On screen, what a
 * chart is about is said by things around it — the place pills at the top of
 * Trends, the card header on Home — which are either far from the chart or
 * full of controls (selectors, buttons) that mean nothing in a picture sent
 * to someone else. So only the chart itself is captured, and the image gets
 * its own heading (which places, which measure) and a footer saying where it
 * came from, so a forwarded image still leads back to the app.
 *
 * WHAT MAY BE WRITTEN ON THE IMAGE. Every word drawn here travels with the
 * picture to people the user never chose to tell where they live. So the
 * legend must carry PUBLIC place names built by the app (lib/public-label.ts),
 * never the "Call this place" nickname, and a typed question must be labelled
 * as the person's own words. The same rule as lib/share.ts: if a server ever
 * draws these images for link previews, it may take only coordinates or IDs
 * from the URL and look the words up itself — never display text from the URL.
 */

import { toCanvas } from "html-to-image";
import { SITE_URL } from "@/lib/share";

export interface ChartImageOptions {
  /** e.g. "Forecast · next 24 hours". */
  title: string;
  /** The places and their line colours, so a two-place chart can be read. */
  legend?: { label: string; color: string }[];
  /** A short line under the title, e.g. "PM2.5 (µg/m³)". */
  subtitle?: string;
}

const PAD = 16;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export async function chartImage(node: HTMLElement, opts: ChartImageOptions): Promise<Blob | null> {
  const ratio = 2;
  const chart = await toCanvas(node, {
    pixelRatio: ratio,
    backgroundColor: "#ffffff",
    // Anything marked as not belonging in the picture (share buttons).
    filter: (el) => !(el instanceof HTMLElement && el.dataset.shareExclude !== undefined),
  });

  const width = chart.width;

  // LEGEND ROWS, worked out before the canvas is sized. Public place names
  // ("Near Kherwadi, Bandra East, Mumbai") are longer than nicknames, and two
  // of them do not fit side by side on a phone-width chart; drawn in one row
  // the second ran off the edge. So each item goes on the current row if it
  // fits, else starts a new one. A measuring canvas is needed first because
  // text width depends on the font.
  const legendFont = `${13 * ratio}px ${FONT}`;
  const measure = document.createElement("canvas").getContext("2d");
  const rows: { label: string; color: string; x: number }[][] = [];
  if (opts.legend?.length && measure) {
    measure.font = legendFont;
    let row: { label: string; color: string; x: number }[] = [];
    let x = PAD * ratio;
    for (const item of opts.legend) {
      const w = 14 * ratio + measure.measureText(item.label).width;
      if (row.length && x + w > width - PAD * ratio) {
        rows.push(row);
        row = [];
        x = PAD * ratio;
      }
      row.push({ ...item, x });
      x += w + 18 * ratio;
    }
    if (row.length) rows.push(row);
  }
  const LEGEND_ROW_H = 20;

  const titleH =
    (rows.length ? 66 + (rows.length - 1) * LEGEND_ROW_H : 46) * ratio +
    (opts.subtitle ? 18 * ratio : 0);
  const footH = 34 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = titleH + chart.height + footH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = PAD * ratio + 16 * ratio;
  ctx.fillStyle = "#12171b";
  ctx.font = `600 ${16 * ratio}px ${FONT}`;
  ctx.fillText(opts.title, PAD * ratio, y);

  if (opts.subtitle) {
    y += 18 * ratio;
    ctx.fillStyle = "#5c6b73";
    ctx.font = `${12 * ratio}px ${FONT}`;
    ctx.fillText(opts.subtitle, PAD * ratio, y);
  }

  ctx.font = legendFont;
  rows.forEach((row, i) => {
    y += (i === 0 ? 22 : LEGEND_ROW_H) * ratio;
    for (const item of row) {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(item.x + 5 * ratio, y - 4 * ratio, 5 * ratio, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#12171b";
      ctx.fillText(item.label, item.x + 14 * ratio, y);
    }
  });

  ctx.drawImage(chart, 0, titleH);

  ctx.fillStyle = "#5c6b73";
  ctx.font = `${12 * ratio}px ${FONT}`;
  const site = SITE_URL.replace(/^https:\/\//, "");
  ctx.fillText(`AirGyaan · air quality forecasts for Indian cities · ${site}`, PAD * ratio, canvas.height - 12 * ratio);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
