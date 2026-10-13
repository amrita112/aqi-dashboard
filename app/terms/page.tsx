/**
 * The terms page.
 *
 * ONE CLAUSE HERE EARNS ITS PLACE and the rest is scaffolding around it: this
 * app tells people when to go outside, using a forecast that is sometimes a
 * seasonal average, built on measurements that are often days old. Someone
 * with asthma may plan a walk around it. Saying plainly what it is — and what
 * it is not — is both the honest thing and the legally useful one.
 *
 * Written to be read. Boilerplate nobody reads protects nobody, and an app
 * whose argument is that it does not overclaim cannot sensibly hide its
 * limitations in capital letters at the bottom.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME, CONTACT_EMAIL } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Terms of use · ${APP_NAME}`,
  description: `What ${APP_NAME} can tell you, what it cannot, and the terms of using it.`,
};

const UPDATED = "13 October 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-3 text-gray-700">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-8 pb-24">
      <h1 className="text-3xl font-bold tracking-tight">Terms of use</h1>
      <p className="mt-1 text-sm text-gray-500">Last updated {UPDATED}</p>

      <p className="mt-6 text-gray-700">
        {APP_NAME} is free, has no accounts, and is run as a public-interest project
        rather than a business. Using it means accepting what follows — most of
        which is about what the numbers actually are.
      </p>

      <Section title="This is a forecast. It can be wrong.">
        <p>
          The number on the home screen is a <strong>prediction</strong>, not a
          measurement of the air where you are standing. It is modelled from the
          three government monitoring stations nearest the place you chose, which
          may be several kilometres away, and from historical patterns for your city
          and the time of year.
        </p>
        <p>
          When no recent reading is available, the app shows the{" "}
          <strong>seasonal average</strong> for those dates instead. It is drawn as
          a dashed line and labelled as an average, never as a forecast, because it
          is a description of a typical year rather than a prediction about this one.
        </p>
        <p>
          India&apos;s public monitoring feed publishes on a delay of days. The app
          tells you how old its data is wherever that matters, and you should read
          those labels — a confident-looking number behind a four-day-old reading is
          still a four-day-old reading.
        </p>
      </Section>

      <Section title="It is not medical advice">
        <p className="rounded-md bg-amber-50 px-4 py-3 text-amber-900">
          Do not use {APP_NAME} to make a medical decision. If you have asthma, a
          heart or lung condition, are pregnant, or are caring for a young child or
          an older person, talk to a doctor about what air quality means for you.
          This app cannot know your circumstances and does not try to.
        </p>
        <p>
          The alert threshold you set during setup is a starting point derived from
          your city&apos;s own history — the median daily peak between October and
          February — not a health guideline, and not a level below which the air is
          safe.
        </p>
      </Section>

      <Section title="The AI answers can be wrong too">
        <p>
          Every number the Ask tab quotes comes from the same database the rest of
          the app uses; the model chooses which figure to look up and writes the
          sentence around it. That design stops it inventing numbers. It does not
          stop it misreading a question, picking the wrong day, or phrasing something
          confusingly.
        </p>
        <p>
          Each question is answered on its own, with no memory of what you asked
          before. If an answer does not match what the forecast and trends screens
          show, trust those.
        </p>
      </Section>

      <Section title="No promise that it keeps working">
        <p>
          The app runs entirely on free service tiers. The AI box has a shared daily
          allowance and stops answering when it is used up; data collection depends
          on third parties we do not control. It may be slow, unavailable, or
          discontinued, without notice and without any obligation on us.
        </p>
        <p>
          Notifications are not switched on yet. Setting a threshold saves your
          preference for when they are — the app will not currently alert you to
          anything.
        </p>
      </Section>

      <Section title="Fair use">
        <p>
          Please do not scrape the app, automate requests against it, or attempt to
          exhaust the shared AI allowance. It is a free service with a small budget,
          and one person doing that takes it away from everyone else. The underlying
          measurements are public — get them from{" "}
          <a href="https://openaq.org" className="text-blue-700 underline" target="_blank" rel="noopener noreferrer">
            OpenAQ
          </a>{" "}
          or{" "}
          <a href="https://airquality.xkdr.org" className="text-blue-700 underline" target="_blank" rel="noopener noreferrer">
            XKDR
          </a>
          , which is where we get them.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          {APP_NAME} is provided as it is, without warranty of any kind. To the
          fullest extent the law allows, we are not liable for any loss or harm
          arising from using it or relying on anything it says. If you do not accept
          that, please do not use the app — which is a real option, offered without
          hard feelings: the data behind it is public and you can read it directly.
        </p>
      </Section>

      <Section title="The code">
        <p>
          The source is open under the GNU Affero General Public License v3.0. You
          may read it, run it, and build your own version, provided a modified
          version you offer to other people publishes its source too. The licence
          covers the code only — the air quality measurements belong to the bodies
          that made them.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions, corrections and complaints:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">
            {CONTACT_EMAIL}
          </a>
          . If a number looks wrong, that is worth telling us about — it is how most
          of the real bugs in this app were found.
        </p>
      </Section>

      <p className="mt-10 text-sm text-gray-500">
        See also the{" "}
        <Link href="/privacy" className="text-blue-700 underline">
          privacy page
        </Link>
        , which says what is stored and what is sent elsewhere.
      </p>
    </main>
  );
}
