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
  const titleH = (opts.legend?.length ? 66 : 46) * ratio + (opts.subtitle ? 18 * ratio : 0);
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

  if (opts.legend?.length) {
    y += 22 * ratio;
    let x = PAD * ratio;
    ctx.font = `${13 * ratio}px ${FONT}`;
    for (const item of opts.legend) {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x + 5 * ratio, y - 4 * ratio, 5 * ratio, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#12171b";
      ctx.fillText(item.label, x + 14 * ratio, y);
      x += 14 * ratio + ctx.measureText(item.label).width + 18 * ratio;
    }
  }

  ctx.drawImage(chart, 0, titleH);

  ctx.fillStyle = "#5c6b73";
  ctx.font = `${12 * ratio}px ${FONT}`;
  const site = SITE_URL.replace(/^https:\/\//, "");
  ctx.fillText(`AirGyaan · air quality forecasts for Indian cities · ${site}`, PAD * ratio, canvas.height - 12 * ratio);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
