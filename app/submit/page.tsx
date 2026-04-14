/**
 * Submit Reading Page — where logged-in users submit a new AQI reading.
 *
 * This page wraps the ReadingForm component and adds a heading.
 * The actual form logic lives in /components/ReadingForm.tsx.
 */

import ReadingForm from "@/components/ReadingForm";

export default function SubmitPage() {
  return (
    <div className="max-w-2xl mx-auto mt-10 p-6">
      <h1 className="text-2xl font-bold mb-2">Submit AQI Reading</h1>
      <p className="text-gray-600 mb-8">
        Enter the AQI value from your monitor. Your location will be
        auto-detected using your device&apos;s GPS.
      </p>
      <ReadingForm />
    </div>
  );
}
