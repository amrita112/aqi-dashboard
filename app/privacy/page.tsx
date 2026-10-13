/**
 * The privacy page.
 *
 * WRITTEN FROM THE CODE, not from a template. Every claim below corresponds to
 * something checkable: the localStorage keys are the ones in lib/prefs.ts and
 * lib/ask-count.ts, the two-year retention is the DEFAULT on
 * petition_signatures.expires_at, the ninety days is in
 * purge_old_usage_events(), and "no SELECT policy" is literally true of that
 * table. A privacy page that cannot be checked against the source is a
 * statement of intent; this one is a description.
 *
 * The thing it exists to say, which nothing in the app said before: a question
 * typed into the Ask box leaves this app. It goes to a third party, with the
 * coordinates of the place the person chose. That is not a dark pattern we are
 * confessing to — it is how the feature works — but it was undisclosed, while
 * a nearby sentence promised their settings never leave the device.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME, CONTACT_EMAIL } from "@/lib/brand";
import { RETENTION_YEARS } from "@/lib/api/petition";

export const metadata: Metadata = {
  title: `Privacy · ${APP_NAME}`,
  description: `What ${APP_NAME} stores, what it sends elsewhere, and how to get rid of it.`,
};

/** Last substantive change. Shown so a reader can tell whether it is current. */
const UPDATED = "13 October 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-3 text-gray-700">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-8 pb-24">
      <h1 className="text-3xl font-bold tracking-tight">Privacy</h1>
      <p className="mt-1 text-sm text-gray-500">Last updated {UPDATED}</p>

      <p className="mt-6 text-gray-700">
        {APP_NAME} has no accounts, no advertising, and nothing to sell. Most of what
        it knows about you never leaves your phone. This page says exactly what the
        exceptions are, because there are two and you should not have to find them
        by reading the source.
      </p>

      <Section title="The short version">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Your city, your pin, your pollutant and your alert threshold are stored
            <strong> on your device only</strong>. We never receive them.
          </li>
          <li>
            <strong>Questions you type into the Ask tab are sent to Groq to be
            answered</strong>, along with the coordinates of your chosen place.
            This is the one part of the app that shares anything you have written.
          </li>
          <li>
            Your name and email are stored <strong>only if you type them into the
            petition or a city request</strong>, and you can delete them yourself.
          </li>
          <li>We count how often features are used, with no identifier attached.</li>
        </ul>
      </Section>

      <Section title="What stays on your device">
        <p>
          Kept in your browser&apos;s local storage, never transmitted: the city and
          the place you picked, whether you chose AQI or PM2.5, your notification
          threshold, your few most recent questions and their answers, how many
          questions you have asked today, and whether you dismissed the
          &ldquo;add to home screen&rdquo; hint.
        </p>
        <p>
          Clearing your browser data erases all of it, and so does{" "}
          <strong>Reset everything</strong> at the bottom of{" "}
          <Link href="/settings" className="text-blue-700 underline">
            Settings
          </Link>
          . Because there is no account, none of it follows you to another device.
        </p>
      </Section>

      <Section title="Questions you ask the AI">
        <p>
          When you ask a question, it is sent to <strong>Groq</strong>, a company in
          the United States, which runs the language model that writes the answer.
          Sent with it: the latitude and longitude of the place you picked, the name
          you gave that place, your city, and whether you read AQI or PM2.5.
        </p>
        <p>
          Groq states that it does not retain data submitted through its free API by
          default. We do not control that policy and cannot promise it on their
          behalf.
        </p>
        <p>
          We do not store your questions. Our own server does not log the text of
          them — only how long a question was, which is enough to debug a failure
          without keeping what you asked.
        </p>
        <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">
          If you would rather not share something, do not type it into the Ask box.
          Every other part of the app — the forecast, the map, trends, the current
          reading — works without sending anything you have written anywhere.
        </p>
      </Section>

      <Section title="If you sign the petition or ask for a city">
        <p>
          Then, and only then, we store the name, email address and city you typed,
          along with what you were told you were agreeing to at the time.
        </p>
        <p>
          <strong>Nobody can read that list through this app.</strong> The table has
          no read permission of any kind — the public count comes from a function
          that returns a number and nothing else. Your name is never shown beside a
          count.
        </p>
        <p>
          Rows are deleted automatically after {RETENTION_YEARS} years. You can
          delete yours sooner with the withdrawal code shown when you signed, which
          removes the row rather than marking it hidden. Lost the code? Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section title="Counting how the app is used">
        <p>
          We record three things: that the app was installed, which of the AI&apos;s
          tools answered a question, and that a question could not be answered along
          with the reason. Each is stored as one short word.
        </p>
        <p>
          No identifier of any kind is attached — no account, no session, no device
          id, no IP address, no question text, no location. The consequence, which is
          deliberate: we can see that forty questions were answered this week and we
          can never tell whether that was forty people or one. These counts are
          deleted after 90 days.
        </p>
        <p>
          Page views are counted by Vercel Analytics, which is cookieless and stores
          no identifier for you.
        </p>
      </Section>

      <Section title="When something breaks">
        <p>
          If a screen fails to load, the app records what went wrong: the error
          message, the technical trace that goes with it, which page it happened on,
          and whether you were using Chrome, Safari or Firefox. That is how we find
          out about faults nobody reports.
        </p>
        <p>
          It records the page, never the full web address, so nothing you typed can
          travel with it. There is no identifier attached and these are deleted after
          30 days. They are stored on our own database, not sent to an error-tracking
          company.
        </p>
      </Section>

      <Section title="Where the air quality data comes from">
        <p>
          Not from you. Every reading is a measurement made by India&apos;s Central
          Pollution Control Board monitoring network, reaching us through OpenAQ and
          the XKDR Forum&apos;s archive. Nothing you do in this app contributes a
          reading, and your location is never used to collect one.
        </p>
      </Section>

      <Section title="Your rights, and how to use them">
        <p>
          Under India&apos;s Digital Personal Data Protection Act you can ask what we
          hold about you, ask for it to be corrected, and withdraw your consent. For
          anything on your device, you do not need us: <strong>Reset everything</strong>{" "}
          in Settings. For a petition signature or a city request, use your
          withdrawal code, or write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">
            {CONTACT_EMAIL}
          </a>
          , which is also where complaints should go.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this page changes in a way that affects what we collect, the date at the
          top changes with it. Anything you already agreed to keeps the wording you
          agreed to — consent text is stored alongside each signature for exactly
          this reason.
        </p>
      </Section>

      <p className="mt-10 text-sm text-gray-500">
        See also the{" "}
        <Link href="/terms" className="text-blue-700 underline">
          terms of use
        </Link>
        , which cover what this app can and cannot tell you.
      </p>
    </main>
  );
}
