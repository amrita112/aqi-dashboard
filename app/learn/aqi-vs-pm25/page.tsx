/**
 * /learn/aqi-vs-pm25 — the longer answer to the setup screen's second question.
 *
 * A SERVER component with no data access: everything here is explanation, and
 * the numbers in it are either definitional (the CPCB breakpoints) or measured
 * once and cited with their date. Nothing live, so nothing to go stale without
 * someone noticing.
 */

import Link from "next/link";
import { APP_NAME } from "@/lib/brand";

export const metadata = {
  title: "AQI or PM2.5?",
  description:
    "What India's Air Quality Index actually measures, how it differs from the PM2.5 concentration, and which one answers your question.",
};

/** Measured across our seven cities on 2026-10-08. See notes in lib/ai/tools.ts. */
const DRIVERS = [
  { city: "Chennai", pm10: 100, no2: 0, pm25: 0 },
  { city: "Pune", pm10: 100, no2: 0, pm25: 0 },
  { city: "Bengaluru", pm10: 61, no2: 21, pm25: 7 },
  { city: "Delhi NCR", pm10: 56, no2: 24, pm25: 20 },
  { city: "Mumbai", pm10: 49, no2: 19, pm25: 32 },
  { city: "Kolkata", pm10: 26, no2: 74, pm25: 0 },
  { city: "Hyderabad", pm10: 0, no2: 66, pm25: 29 },
];

/** CPCB sub-index for PM2.5, from the official breakpoint table. */
const SCALE = [
  { ugm3: 10, index: 17, band: "Good" },
  { ugm3: 30, index: 50, band: "Good" },
  { ugm3: 40, index: 67, band: "Satisfactory" },
  { ugm3: 60, index: 100, band: "Satisfactory" },
  { ugm3: 70, index: 134, band: "Moderate" },
  { ugm3: 90, index: 200, band: "Moderate" },
  { ugm3: 120, index: 300, band: "Poor" },
  { ugm3: 150, index: 324, band: "Very Poor" },
];

export default function AqiVsPm25Page() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">AQI or PM2.5?</h1>
      <p className="mt-4 text-lg text-gray-700">
        They are not two measurements of the same thing. One is a scale, the other is an
        amount, and they answer different questions.
      </p>

      <h2 className="mt-10 text-xl font-semibold">PM2.5 is an amount</h2>
      <p className="mt-3 text-gray-700">
        PM2.5 is the mass of particles smaller than 2.5 micrometres in a cubic metre of air,
        in µg/m³. Those particles are small enough to pass the nose and throat and reach deep
        into the lungs, and from there into the bloodstream. It is the pollutant most of the
        long-term health research is about — heart disease, stroke, lung function in children.
        The WHO guideline is an annual mean of 5 µg/m³ and a 24-hour mean of 15 µg/m³.
      </p>

      <h2 className="mt-10 text-xl font-semibold">AQI is a scale, and it reports the worst</h2>
      <p className="mt-3 text-gray-700">
        India&apos;s National Air Quality Index converts each pollutant into a 0–500 sub-index
        using CPCB&apos;s breakpoint tables, and then reports{" "}
        <strong>the highest one</strong> — not an average. So the AQI you see is a statement
        about whichever pollutant happened to be worst, and the number alone does not say
        which.
      </p>
      <p className="mt-3 text-gray-700">
        This surprises people, because &quot;air quality index&quot; sounds like a summary. It
        is closer to a worst-case alarm.
      </p>

      <h2 className="mt-10 text-xl font-semibold">
        In Indian cities, PM2.5 usually is not what AQI is reporting
      </h2>
      <p className="mt-3 text-gray-700">
        We measured which pollutant drove the index at every station we track, on 8 October
        2026. PM10 — coarse dust from roads, construction and demolition — wins most often,
        and nitrogen dioxide from traffic wins in two cities.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">City</th>
              <th className="py-2 font-medium">PM10 drives</th>
              <th className="py-2 font-medium">NO₂ drives</th>
              <th className="py-2 font-medium">PM2.5 drives</th>
            </tr>
          </thead>
          <tbody>
            {DRIVERS.map((d) => (
              <tr key={d.city} className="border-b border-gray-100">
                <td className="py-2 font-medium text-gray-900">{d.city}</td>
                <td className="py-2 text-gray-700">{d.pm10}%</td>
                <td className="py-2 text-gray-700">{d.no2}%</td>
                <td className="py-2 font-semibold text-gray-900">{d.pm25}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        Percentage of readings where that pollutant&apos;s sub-index was the highest. Rows do
        not reach 100% because SO₂ occasionally wins.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Why PM2.5 looks lower than AQI</h2>
      <p className="mt-3 text-gray-700">
        Because AQI is the maximum across pollutants, the PM2.5 sub-index can never be higher
        than the AQI, and is usually lower. The conversion is also strongly non-linear: a
        small rise in concentration can cross a band boundary.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">PM2.5 (µg/m³)</th>
              <th className="py-2 font-medium">Sub-index</th>
              <th className="py-2 font-medium">Band</th>
            </tr>
          </thead>
          <tbody>
            {SCALE.map((r) => (
              <tr key={r.ugm3} className="border-b border-gray-100">
                <td className="py-2 text-gray-900">{r.ugm3}</td>
                <td className="py-2 text-gray-700">{r.index}</td>
                <td className="py-2 text-gray-700">{r.band}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        60 → 70 µg/m³ is a 17% rise in what you breathe, and moves the index from 100 to 134 —
        Satisfactory into Moderate.
      </p>

      <h2 className="mt-10 text-xl font-semibold">So which should you pick?</h2>
      <p className="mt-3 text-gray-700">
        Pick <strong>AQI</strong> if you want the number everyone else quotes — the news, other
        apps, the government dashboards. It is the right choice for &quot;is today unusually
        bad&quot;.
      </p>
      <p className="mt-3 text-gray-700">
        Pick <strong>PM2.5</strong> if you care about the pollutant with the clearest long-term
        health evidence, or you want to compare against WHO guidelines, which are written in
        µg/m³ and cannot be compared to an index at all.
      </p>
      <p className="mt-3 text-gray-700">
        You can change it at any time in {APP_NAME}&apos;s settings, and it only changes which
        number leads.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Where to read more</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-gray-700">
        <li>
          <a
            className="underline"
            href="https://cpcb.nic.in/National-Air-Quality-Index/"
            target="_blank"
            rel="noopener noreferrer"
          >
            CPCB — National Air Quality Index
          </a>{" "}
          — the official method and the breakpoint tables this app uses.
        </li>
        <li>
          <a
            className="underline"
            href="https://www.who.int/publications/i/item/9789240034228"
            target="_blank"
            rel="noopener noreferrer"
          >
            WHO global air quality guidelines (2021)
          </a>{" "}
          — the health evidence behind the PM2.5 limits.
        </li>
        <li>
          <a
            className="underline"
            href="https://www.stateofglobalair.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            State of Global Air
          </a>{" "}
          — burden-of-disease estimates by country, updated annually.
        </li>
      </ul>

      <p className="mt-10">
        <Link href="/setup" className="text-blue-700 underline">
          Back to setup
        </Link>
      </p>
    </main>
  );
}
