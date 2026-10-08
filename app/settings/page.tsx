/**
 * /settings — change any one answer without redoing the other two.
 *
 * Previously the Settings tab pointed at /setup, which marched someone through
 * all three questions in order to change one of them, and discarded their
 * answers if they backed out. A settings page is a list of things you own, not
 * a flow.
 *
 * A server component wrapping the client screen, so this file can export
 * metadata.
 */

import SettingsScreen from "@/components/SettingsScreen";
import { APP_NAME } from "@/lib/brand";

export const metadata = {
  title: "Settings",
  description: `Change your place, the number you see, and when ${APP_NAME} warns you.`,
};

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-lg px-5 py-8">
      <SettingsScreen />
    </main>
  );
}
