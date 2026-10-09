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
import Collapsible from "@/components/Collapsible";

/** Public, so "raise an issue" is a real option rather than an invitation to email. */
const REPO = "https://github.com/amrita112/aqi-dashboard";

export const metadata = {
  title: "About the data",
  description:
    "Where these numbers come from, what India's Air Quality Index measures, how far ahead a forecast is worth trusting, and what this app cannot tell you.",
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
      <h1 className="text-3xl font-bold tracking-tight">About the data</h1>
      <p className="mt-4 text-lg text-gray-700">
        Where these numbers come from, how much to trust them, and what they cannot tell you.
      </p>

      <h2 className="mt-10 text-xl font-semibold">AQI or PM2.5?</h2>
      <p className="mt-3 text-gray-700">
        They are not two measurements of the same thing. One is a scale, the other is an
        amount, and they answer different questions.
      </p>

      <div className="mt-8">
        <Collapsible title="Where these numbers come from" defaultOpen>
          <p>
            Every reading in this app is a measurement made by someone else. We operate no
            sensors. The chain is: India&apos;s Central Pollution Control Board and the state
            boards run the monitoring stations; OpenAQ collects and republishes what they
            publish; this app reads OpenAQ, converts everything to common units, and computes
            the index the same way CPCB defines it.
          </p>
          <p>
            Historical data for fitting the forecast comes from the XKDR Forum&apos;s archive of
            the same network, which reaches back to 2015 and is more complete than what the
            live feed exposes.
          </p>
          <p>
            Nothing here is crowdsourced, estimated from satellite imagery, or modelled from
            traffic. If a number is on screen, a government instrument produced it.
          </p>
        </Collapsible>

        <Collapsible title="How old the data is, and why that matters most">
          <p>
            This is the limitation that shapes everything else in the app, so it is worth
            being blunt about. Government monitors report to the public feed on a delay. We
            measured it station by station in October 2026: the typical reading is about{" "}
            <strong>4.6 days old</strong> by the time anyone outside the network can see it,
            and the slowest station took 7.7 days.
          </p>
          <p>
            That is not a bug in this app, and widening the net does not fix it. It is how
            fast the data is published.
          </p>
          <p>
            The consequence is specific. A forecast is only as good as the most recent reading
            behind it, and skill decays sharply as that reading ages. Measured per station for
            next-day PM2.5 in Delhi, against simply quoting the seasonal average:
          </p>
          <ul>
            <li>same-day reading: about a third better than the seasonal average</li>
            <li>one day old: about a fifth better</li>
            <li>two days old: about a tenth better</li>
            <li>four days old: no better at all</li>
          </ul>
          <p>
            So when the app says <em>&quot;typical for this time of year — no recent reading to
            predict from&quot;</em>, it is not hedging. It is telling you that the number on
            screen is a seasonal average and should not be read as a prediction.
          </p>
        </Collapsible>

        <Collapsible title="How far the data spreads: a few dozen points per city">
          <p>
            Delhi NCR has 63 government monitors for a metropolitan area of more than thirty
            million people. Bengaluru has eleven. Air quality varies street by street — near
            traffic, near construction, near burning — and a few dozen points cannot describe
            that.
          </p>
          <p>
            This app averages the three stations nearest the place you chose, rather than
            quoting the single closest one. Three is a compromise: one station is noisy and
            sometimes simply absent, while a city-wide average hides exactly the local
            differences that would change what you do today.
          </p>
          <p>
            It means the number you see is the air in your <em>neighbourhood</em>, not at your
            doorstep, and that the distance to those three stations matters. The map shows the
            ring they are averaged over.
          </p>
        </Collapsible>

        <Collapsible title="How the forecast works">
          <p>
            Deliberately simple, because the data does not support anything more elaborate.
            Two pieces, multiplied:
          </p>
          <ul>
            <li>
              <strong>A daily level.</strong> For each station we fit a seasonal climatology —
              the typical value for that day of the year, smoothed — and then carry forward the
              most recent departure from it, damped by a weight fitted on past years.
              Yesterday being unusually bad is evidence that today will be too, but weaker
              evidence the older it gets.
            </li>
            <li>
              <strong>An hourly shape.</strong> A ratio curve per city, per month, per hour,
              learned from years of history and multiplied onto the daily level. It is a ratio
              rather than a fixed profile, so a shape learned in a clean month still applies in
              a dirty one.
            </li>
          </ul>
          <p>
            It is tested against two baselines it has to beat to earn its place: persistence
            (tomorrow equals today) and climatology (tomorrow equals the seasonal average).
            Beating climatology is what the app reports as skill. Persistence is the harder
            baseline at one day out, and collapses beyond that — which is most of why the model
            is worth having.
          </p>
          <p>
            Beyond about four days, nothing we can do beats the seasonal average, so that is
            what the app shows, labelled as such and drawn with a dashed line.
          </p>
        </Collapsible>

        <Collapsible title="What this app cannot tell you">
          <p>
            Being clear about this is more useful than pretending otherwise:
          </p>
          <ul>
            <li>
              <strong>What the air is like right now.</strong> Readings are days old. The app
              says how old, and that age is usually the most important thing on the screen.
            </li>
            <li>
              <strong>The air at your exact address.</strong> The nearest station may be
              kilometres away, across a main road, or downwind of something you are not.
            </li>
            <li>
              <strong>Anywhere without a monitor.</strong> A neighbourhood with no station
              cannot be reported on, and the app will say so rather than guess.
            </li>
            <li>
              <strong>Indoor air</strong>, which is what most people breathe most of the time
              and is a different measurement entirely.
            </li>
            <li>
              <strong>Health advice.</strong> Band names are CPCB&apos;s descriptions of
              concentration, not clinical guidance for you specifically.
            </li>
          </ul>
        </Collapsible>

        <Collapsible title="The code, and how to report something wrong">
          <p>
            The app is open source, including the ingest jobs, the forecasting code and the
            notebooks used to validate it. If you think a number is wrong, the fastest way to
            get it looked at is to say so there, with the place and the date.
          </p>
          <p>
            <a
              className="font-medium text-blue-700 underline"
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
            >
              Browse the code on GitHub
            </a>
            {" · "}
            <a
              className="font-medium text-blue-700 underline"
              href={`${REPO}/issues/new`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Raise an issue
            </a>
          </p>
          <p>
            Useful things to include: the city or station, the date, what the app showed and
            what you expected. A screenshot settles most questions immediately.
          </p>
        </Collapsible>
      </div>

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

      {/* No "back to setup" link: this opens in its own tab from the setup
          screen, so the way back is to close it, and a link would navigate the
          wrong tab and restart the flow. The link is to the app for people who
          arrive here directly. */}
      <p className="mt-10">
        <Link href="/" className="text-blue-700 underline">
          Go to {APP_NAME}
        </Link>
      </p>
    </main>
  );
}
