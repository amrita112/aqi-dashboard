/**
 * Reading Form — the form where users submit a new AQI reading.
 *
 * "use client" because this component handles user interaction:
 * - Detects the user's GPS location via the browser
 * - Accepts typed input (the AQI value)
 * - Sends data to Supabase when the user clicks Submit
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { insertReading } from "@/lib/queries";

export default function ReadingForm() {
  // Form state — tracks what the user has entered and the current status
  const [aqiValue, setAqiValue] = useState<string>("");  // The AQI number (as text, converted to number on submit)
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [locationStatus, setLocationStatus] = useState<string>("Click to detect your location");
  const [submitting, setSubmitting] = useState(false);  // True while the form is being sent
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  /**
   * Detect the user's location using the browser's GPS.
   * This triggers the browser's "Allow location access?" popup.
   */
  const detectLocation = () => {
    // Check if the browser supports geolocation (almost all modern browsers do)
    if (!navigator.geolocation) {
      setLocationStatus("Your browser doesn't support geolocation");
      return;
    }

    setLocationStatus("Detecting location...");

    navigator.geolocation.getCurrentPosition(
      // Success: we got the coordinates
      (position) => {
        setLatitude(position.coords.latitude);
        setLongitude(position.coords.longitude);
        setLocationStatus(
          `Location detected: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`
        );
      },
      // Error: something went wrong (user denied permission, GPS unavailable, etc.)
      (err) => {
        setLocationStatus(`Could not detect location: ${err.message}`);
      },
      // Options: high accuracy uses GPS instead of just Wi-Fi/cell towers
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  /**
   * Handle form submission — validate inputs and send to Supabase.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();  // Prevent the browser from reloading the page (default form behavior)
    setError(null);

    // Validate: AQI value must be a number between 0 and 500
    const numericAqi = parseInt(aqiValue, 10);
    if (isNaN(numericAqi) || numericAqi < 0 || numericAqi > 500) {
      setError("AQI value must be a number between 0 and 500");
      return;
    }

    // Validate: location must be detected
    if (latitude === null || longitude === null) {
      setError("Please detect your location first");
      return;
    }

    setSubmitting(true);

    try {
      // Get the currently logged-in user's ID (needed for the security policy)
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError("You must be logged in to submit a reading");
        setSubmitting(false);
        return;
      }

      await insertReading(supabase, {
        user_id: user.id,
        aqi_value: numericAqi,
        latitude,
        longitude,
        recorded_at: new Date().toISOString(),  // Current time as the reading timestamp
      });

      // Success — redirect to the dashboard to see the new reading
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Failed to submit reading");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-6">
      {/* AQI Value Input */}
      <div>
        <label htmlFor="aqi" className="block text-sm font-medium text-gray-700 mb-1">
          AQI Value (0–500)
        </label>
        <input
          id="aqi"
          type="number"
          min="0"
          max="500"
          value={aqiValue}
          onChange={(e) => setAqiValue(e.target.value)}
          placeholder="Enter AQI reading"
          className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      {/* Location Detection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Your Location
        </label>
        <button
          type="button"
          onClick={detectLocation}
          className="w-full px-4 py-2 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 text-sm"
        >
          📍 Detect My Location
        </button>
        <p className="mt-1 text-sm text-gray-500">{locationStatus}</p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
          {error}
        </div>
      )}

      {/* Submit Button */}
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Submitting..." : "Submit Reading"}
      </button>
    </form>
  );
}
