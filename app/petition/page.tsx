/**
 * /petition — the case for hyperlocal measurement, and a place to sign.
 *
 * A SERVER component. It reads the signature count on the server and renders
 * the argument as plain HTML, so the explanatory half of the page costs the
 * visitor no JavaScript. Only the form itself is a client component, because
 * only the form needs state.
 *
 * The numbers below are measured, not rhetorical. They come from checking every
 * OpenAQ location within 25 km of each city centre on 2026-09-28, and they are
 * the same numbers the app uses to decide whether it can show a forecast at
 * all. That is the point of the page: the product's own limitation, stated
 * honestly, is the argument.
 */

import PetitionForm from "@/components/PetitionForm";
import { PETITION_PURPOSE } from "@/lib/api/petition";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Measure the air where people actually live",
  description:
    "India's government air quality monitors report days late and cover a handful of points per city. Add your name to the case for measuring street by street.",
};

/** Measured 2026-09-28. See lib/api/data-quality.ts. */
const COVERAGE = [
  { city: "Delhi", stations: 80, fresh: 0, medianDays: 3.9 },
  { city: "Mumbai", stations: 43, fresh: 0, medianDays: 3.9 },
  { city: "Bengaluru", stations: 20, fresh: 0, medianDays: 9.2 },
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
        That is not a flaw in the forecast. It is what the underlying data looks like.
      </p>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Checked on 28 September 2026
        </h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-medium">City</th>
              <th className="py-1 font-medium">Government monitors</th>
              <th className="py-1 font-medium">Reported in last 48h</th>
              <th className="py-1 font-medium">Typical delay</th>
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
          Across all three cities, six privately-run sensors were reporting live. Everything
          else arrives days later, if at all.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold">Why this matters more than it sounds</h2>
      <p className="mt-3 text-gray-700">
        A handful of monitors per city, reporting days late, cannot tell you about the road
        you walk down or the park you run in. Air quality varies street by street — near
        traffic, near construction, near burning — and a city-wide average hides exactly the
        differences that would change what someone does that day.
      </p>
      <p className="mt-3 text-gray-700">
        Denser, faster measurement is not technically hard. Low-cost sensors already exist
        and already work; the six that were live when we checked are proof of it. What is
        missing is enough of them, in enough places, with the data made open.
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
