/**
 * /setup — the first run.
 *
 * Three questions, then the app is usable. A server component wrapping the
 * client flow, so the heading and framing cost no JavaScript.
 *
 * Reached automatically from / when no preferences are stored, and directly
 * when someone wants to change them.
 */

import { APP_NAME } from "@/lib/brand";
import SetupFlow from "@/components/SetupFlow";

export const metadata = {
  title: "Set up",
  description: "Three questions, then you are done.",
};

export default function SetupPage() {
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Welcome to {APP_NAME}</h1>
      <p className="mt-2 text-gray-600">
        To get started, please answer three questions. You can change your answers any time
        from the settings tab.
      </p>

      <div className="mt-8">
        <SetupFlow />
      </div>
    </main>
  );
}
