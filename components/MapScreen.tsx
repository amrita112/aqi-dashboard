"use client";

/**
 * The /map screen's client half: the header, the preferences check, and the
 * dynamically-imported Leaflet map.
 *
 * Split from the page so the page itself can stay a server component and
 * export `metadata` — a client component cannot.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadPrefs } from "@/lib/prefs";

const StationMap = dynamic(() => import("@/components/StationMap"), {
  ssr: false,
  loading: () => (
    <div className="h-[60vh] w-full animate-pulse rounded-lg border border-gray-200 bg-gray-100" />
  ),
});

export default function MapScreen() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The map needs a centre, and the centre is the place chosen at first run.
    if (!loadPrefs()) router.replace("/setup");
    else setReady(true);
  }, [router]);

  return (
    /* The header lives in StationMap now, with the pollutant selector beside
       it. This wrapper exists only so /map can stay a server component and
       export metadata, which a client component cannot. */
    <main className="mx-auto max-w-lg px-5 py-8">{ready && <StationMap />}</main>
  );
}
