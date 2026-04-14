/**
 * Home Page — the landing page at the root URL (/).
 *
 * This is a simple welcome page that directs users to either
 * sign up or view the dashboard.
 */

import Link from "next/link";

export default function Home() {
  return (
    <div className="max-w-3xl mx-auto mt-20 px-6 text-center">
      {/* Hero section */}
      <h1 className="text-4xl font-bold mb-4">
        Crowdsourced Air Quality for India
      </h1>
      <p className="text-lg text-gray-600 mb-8">
        Help map India&apos;s air quality. Submit AQI readings from your home monitor
        and see real-time data from contributors across the country.
      </p>

      {/* Call-to-action buttons */}
      <div className="flex items-center justify-center gap-4">
        <Link
          href="/dashboard"
          className="px-6 py-3 bg-blue-600 text-white rounded-md text-lg hover:bg-blue-700"
        >
          View Dashboard
        </Link>
        <Link
          href="/signup"
          className="px-6 py-3 border border-gray-300 rounded-md text-lg hover:bg-gray-50"
        >
          Sign Up
        </Link>
      </div>

      {/* How it works section */}
      <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <h3 className="font-semibold text-lg mb-2">1. Sign Up</h3>
          <p className="text-gray-600 text-sm">
            Create a free account with your email address.
          </p>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <h3 className="font-semibold text-lg mb-2">2. Submit Readings</h3>
          <p className="text-gray-600 text-sm">
            Enter the AQI value from your monitor. Your location is detected automatically.
          </p>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <h3 className="font-semibold text-lg mb-2">3. View the Map</h3>
          <p className="text-gray-600 text-sm">
            See AQI readings across India on an interactive map with time series charts.
          </p>
        </div>
      </div>
    </div>
  );
}
