/**
 * /petition — the case for hyperlocal measurement, and a place to sign.
 *
 * A SERVER component. It reads the signature count on the server and renders
 * the argument as plain HTML, so the explanatory half of the page costs the
 * visitor no JavaScript. Only the form itself is a client component, because
 * only the form needs state.
 *
 * The numbers below are measured, not rhetorical: every station we track, as of
 * 2026-10-06, counted the way the app itself counts when deciding whether it
 * can show a forecast at all. That is the point of the page — the product's own
 * limitation, stated honestly, is the argument.
 *
 * TWO CLAIMS, BOTH NOW MEASURED AT THE SOURCE:
 *
 *   - SPARSITY. 63 government monitors for Delhi NCR is a fact about the
 *     network, independent of anything we do.
 *   - DELAY. Measured by asking OpenAQ directly, station by station, rather than
 *     inferred from our own database — which could not answer it, because our
 *     own fetch schedule censored the observation. Across 45 PM2.5 sensors in
 *     Delhi, Mumbai and Bengaluru the median publication lag is 109.7 hours,
 *     about 4.6 days, and the slowest is 7.7 days. Nearly every station reports
 *     the SAME age, so this is one bulk publish every few days rather than a
 *     steady per-station delay.
 *
 * An earlier version of this comment said the delay was "partly ours" and
 * declined to attribute it. That was the right caution at the time and is now
 * superseded by the measurement: our window was too narrow to reach data that
 * was already 4.6 days old at the source, which is a separate bug and did not
 * create the 4.6 days.
 */

import PetitionForm from "@/components/PetitionForm";
import { PETITION_PURPOSE } from "@/lib/api/petition";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Measure the air where people actually live",
  description:
    "A few dozen government air quality monitors cover each Indian city, and the public data reaches apps like this one days late. Add your name to the case for measuring street by street.",
};

/**
 * Measured 2026-10-06 across every station we ingest. See lib/api/data-quality.ts.
 *
 * `stations` counts government monitors only. `fresh` is how many of them had
 * produced a reading less than 48 hours old at the time of measurement.
 * `medianDays` is the age of the freshest reading available for the median
 * station — not an average delay, which would hide that most stations have
 * nothing recent at all.
 */
const COVERAGE = [
  { city: "Delhi NCR", stations: 63, fresh: 0, medianDays: 9.8 },
  { city: "Mumbai", stations: 19, fresh: 0, medianDays: 7.3 },
  { city: "Bengaluru", stations: 11, fresh: 0, medianDays: 9.8 },
];

async function signatureCount(): Promise<number | null> {
  try {
    const { data, error } = await createClient().rpc("petition_count");
    return error ? null : (data ?? 0);
  } catch {
    // The page is worth showing even if the count cannot be read.
    return null;
  }
}

export default async function PetitionPage() {
  const count = await signatureCount();

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="text-3xl font-bold tracking-tight">
        Measure the air where people actually live
      </h1>

      <p className="mt-4 text-lg text-gray-700">
        This app tells you what tomorrow&apos;s air is likely to be. Quite often it has to
        tell you something much weaker — that the number on screen is just the seasonal
        average, because no monitor near you has reported recently enough to predict from.
      </p>

      <p className="mt-4 text-gray-700">
        That is not a flaw in the forecast. It is what the underlying data looks like — and
        air quality this old cannot answer a question about today.
      </p>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Checked on 6 October 2026
        </h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-medium">City</th>
              <th className="py-1 font-medium">Government monitors</th>
              <th className="py-1 font-medium">Reported in last 48h</th>
              <th className="py-1 font-medium">Freshest reading, median station</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGE.map((c) => (
              <tr key={c.city} className="border-t border-gray-100">
                <td className="py-2 font-medium text-gray-900">{c.city}</td>
                <td className="py-2 text-gray-700">{c.stations}</td>
                <td className="py-2 font-semibold text-red-700">{c.fresh}</td>
                <td className="py-2 text-gray-700">{c.medianDays} days</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm text-gray-600">
          Across all seven cities we cover, three privately-run sensors had reported in the
          last two days. Of the 126 government monitors, none had.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          We checked this at the source rather than trusting our own records: asked station
          by station, the public feed publishes a batch roughly every few days, and the
          typical reading is already <strong>4.6 days old</strong> by the time it is
          available to anyone at all. The slowest station we found takes 7.7 days.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold">Why this matters more than it sounds</h2>
      <p className="mt-3 text-gray-700">
        Delhi NCR has 63 government monitors for a metropolitan area of more than thirty
        million people. Bengaluru has eleven. However promptly those monitors reported, a
        few dozen points cannot tell you about the road you walk down or the park you run
        in. Air quality varies street by street — near traffic, near construction, near
        burning — and a city-wide average hides exactly the differences that would change
        what someone does that day.
      </p>
      <p className="mt-3 text-gray-700">
        Denser, faster measurement is not technically hard. Low-cost sensors already exist
        and already work — the handful reporting live while we built this are proof of it.
        What is missing is enough of them, in enough places, reporting promptly, with the
        data made open.
      </p>

      <h2 className="mt-10 text-xl font-semibold">What your name is for</h2>
      <p className="mt-3 text-gray-700">
        We are making the case to funders for building this out — a dense, open network
        measuring air street by street, starting in the cities this app already covers.
        Showing that people want it is a large part of that argument.
      </p>
      <p className="mt-3 text-gray-700">
        Signing costs you nothing and commits you to nothing.
      </p>

      {count !== null && count > 0 && (
        <p className="mt-6 text-sm font-medium text-gray-900">
          {count.toLocaleString("en-IN")} {count === 1 ? "person has" : "people have"} signed
          so far.
        </p>
      )}

      <div className="mt-6">
        <PetitionForm purpose={PETITION_PURPOSE} />
      </div>

      <p className="mt-8 text-sm text-gray-500">
        Already signed and want your name removed? Use the code you were shown, or email us
        and we will do it.
      </p>
    </main>
  );
}
