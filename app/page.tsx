/**
 * / — the home screen.
 *
 * Replaces the original landing page for the crowdsourced-readings app. That
 * product's screens (/dashboard, /submit, /login, /signup) are still reachable
 * by URL and still work; they are simply no longer what the front door is for.
 *
 * A server shell around a client component: the user's chosen place lives in
 * localStorage, so the content has to be assembled in the browser. Someone with
 * no preferences stored is sent to /setup.
 */

import HomeScreen from "@/components/HomeScreen";

export const metadata = {
  title: "Air quality near you",
  description: "Tomorrow's air, for seven Indian cities.",
};

export default function Home() {
  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <HomeScreen />
    </main>
  );
}
