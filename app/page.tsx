/**
 * / — the home screen.
 *
 * Replaces the original landing page for the crowdsourced-readings app, whose
 * screens were deleted before launch — they were unlinked but still deployed,
 * and /signup was a working account-creation form for a feature this app does
 * not have.
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
  // Less padding on a phone than on a laptop: py-8 spent 64px of a 390px
  // screen's height on empty margin. The laptop keeps it, having the room.
  return (
    <main className="mx-auto max-w-lg lg:max-w-5xl px-5 py-4 lg:py-8">
      <HomeScreen />
    </main>
  );
}
