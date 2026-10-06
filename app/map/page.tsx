/**
 * /map — where the monitors are, and how stale each one is.
 *
 * The map component is loaded with `ssr: false` because Leaflet reaches for
 * `window` at import time and will crash a server render.
 *
 * Someone with no preferences is sent to /setup by the client component rather
 * than here: the map needs a centre, and the centre is the place they chose.
 */

"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadPrefs } from "@/lib/prefs";

const StationMap = dynamic(() => import("@/components/StationMap"), {
  ssr: false,
  loading: () => (
    <div className="h-[60vh] w-full animate-pulse rounded-lg border border-gray-200 bg-gray-100" />
  ),
});

export default function MapPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!loadPrefs()) router.replace("/setup");
    else setReady(true);
  }, [router]);

  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Monitors</h1>
          <p className="text-sm text-gray-600">What the stations near you last reported</p>
        </div>
        <Link href="/" className="text-sm text-blue-700 underline">Today</Link>
      </header>
      {ready && <StationMap />}
    </main>
  );
}
