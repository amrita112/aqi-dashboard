/**
 * /setup — the first run.
 *
 * Three questions, then the app is usable. A server component wrapping the
 * client flow, so the heading and framing cost no JavaScript.
 *
 * Reached automatically from / when no preferences are stored, and directly
 * when someone wants to change them.
 */

import SetupFlow from "@/components/SetupFlow";

export const metadata = {
  title: "Set up",
  description: "Three questions, then you are done.",
};

export default function SetupPage() {
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Let&apos;s set this up</h1>
      <p className="mt-2 text-gray-600">
        Three questions. It takes about twenty seconds, and you can change any of it later.
      </p>

      <div className="mt-8">
        <SetupFlow />
      </div>
    </main>
  );
}
