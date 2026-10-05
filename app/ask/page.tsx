/**
 * /ask — the question box.
 *
 * Wrapped in Suspense because AskScreen reads the ?q= search param, and
 * useSearchParams opts a component into client-side rendering that Next needs
 * a boundary for at build time.
 */

import { Suspense } from "react";
import AskScreen from "@/components/AskScreen";

export const metadata = {
  title: "Ask about the air",
  description: "Plain questions about air quality, answered from measurements.",
};

export default function AskPage() {
  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <Suspense fallback={<p className="text-gray-500">Loading…</p>}>
        <AskScreen />
      </Suspense>
    </main>
  );
}
