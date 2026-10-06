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
import { APP_NAME, APP_DESCRIPTION } from "@/lib/brand";

export const metadata = {
  // Spelled out rather than relying on the layout's "%s · APP_NAME" template:
  // Next applies a template to CHILD segments only, and this page sits in the
  // same segment as app/layout.tsx, so the template never reaches it. Without
  // this the home tab read "Air quality near you" with no app name at all.
  title: `Air quality near you · ${APP_NAME}`,
  description: APP_DESCRIPTION,
};

export default function Home() {
  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <HomeScreen />
    </main>
  );
}
