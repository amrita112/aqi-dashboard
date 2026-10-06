/**
 * /trends — when tomorrow is worst, and whether it is getting worse.
 *
 * A server shell around a client component: the charts need the user's place,
 * which lives in localStorage, and recharts renders in the browser.
 */

import TrendsScreen from "@/components/TrendsScreen";

export const metadata = {
  title: "Trends",
  description: "Tomorrow hour by hour, and the last month of air quality where you are.",
};

export default function TrendsPage() {
  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <TrendsScreen />
    </main>
  );
}
