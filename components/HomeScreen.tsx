"use client";

/**
 * What someone sees when they open the app.
 *
 * ORDER IS THE DESIGN, and it changed after the 7 Oct review. Top to bottom:
 * the app's name, the question box, today's number with the place it is for,
 * and the forecast. Everything else that used to be here — a threshold
 * banner, the last measured reading, the list of contributing stations, and a
 * box explaining the data's age — has gone.
 *
 * WHY THOSE WENT. Each was defensible alone and together they buried the
 * number. The threshold warning is now the "Tomorrow" line turning red, which
 * says the same thing in the place the eye already is. The station list is one
 * line and an info button. The staleness explanation lives on the data-quality
 * route and the petition page rather than on the screen someone opens to check
 * one number.
 *
 * THE MAP WENT TOO, after the 19 Oct review. At the size Home could give it,
 * it was too small to read and added nothing the Map tab does not do better —
 * and on a phone it hung down behind the tab bar. Its space went to the
 * forecast, which is what someone opening the app came for.
 *
 * A client component because the user's place lives in localStorage; there is
 * no account to read it from on the server.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loadPrefs, placeQuery, MEASUREMENT_COPY, NEAREST_K, type Prefs } from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import ForecastChart, { type ForecastDayInput } from "@/components/ForecastChart";
import InstallHint from "@/components/InstallHint";
import BandLegend from "@/components/BandLegend";
import ShareButton from "@/components/ShareButton";
import { APP_SHARE_TEXT } from "@/lib/share";

interface Band {
  label: string;
  color: string;
  textColor: string;
}
interface Day {
  target_date: string;
  horizon_days: number;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  band: Band;
  hourly: { hour: number; value: number; band_low: number | null; band_high: number | null }[] | null;
}
interface StationRef {
  monitor_id: string;
  name: string;
  distance_km: number;
}

/** "Today", "Thu", "Fri" — the axis labels in the mockup. */
function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Today";
  const d = new Date(`${iso}T12:00:00+05:30`);
  return d.toLocaleDateString("en-IN", { weekday: "short" });
}

/** "a little worse, around 160" — plain words before the number. */
function describeChange(todayValue: number | null, tomorrowValue: number): string {
  if (todayValue === null) return `around ${Math.round(tomorrowValue)}`;
  const diff = tomorrowValue - todayValue;
  const rel = Math.abs(diff) / Math.max(todayValue, 1);
  const word =
    rel < 0.05 ? "about the same" : diff > 0 ? "a little worse" : "a little better";
  const strong = rel >= 0.25 ? (diff > 0 ? "worse" : "better") : word;
  return `${strong}, around ${Math.round(tomorrowValue)}`;
}

/**
 * Twenty-four hours from the current hour, spanning midnight.
 *
 * Genuinely rolling, not "today": at 9pm, "today's forecast" is three hours
 * of information and the useful answer is about tomorrow morning. Trimming
 * the hour arrays rather than the days keeps ForecastChart's day grouping
 * intact, so the midnight boundary still draws itself.
 */
function nextDayPoints(days: Day[], todayIso: string): ForecastDayInput[] {
  // IST hour, computed the same way as everywhere else in the app: shift the
  // instant and read it as UTC.
  const nowHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  const out: ForecastDayInput[] = [];
  let taken = 0;

  for (const d of days) {
    if (!d.hourly?.length) continue;
    const isToday = d.target_date === todayIso;
    const hours = d.hourly.filter((h) => {
      if (taken >= 24) return false;
      if (isToday && h.hour < nowHour) return false;
      taken += 1;
      return true;
    });
    if (hours.length) {
      out.push({
        target_date: d.target_date,
        value: d.value,
        band_low: d.band_low,
        band_high: d.band_high,
        mode: d.mode,
        hourly: hours,
        label: dayLabel(d.target_date, todayIso),
      });
    }
  }
  return out;
}

/** The run of hours with the lowest values — "2–4 pm" in the mockup. */
function cleanestWindow(hours: { hour: number; value: number }[] | null): string | null {
  if (!hours || hours.length < 6) return null;
  // Daytime only: the small hours are usually cleanest and advising someone to
  // go out at 4am is useless even when it is true.
  const day = hours.filter((h) => h.hour >= 6 && h.hour <= 21);
  if (day.length < 4) return null;
  let best = { start: day[0].hour, mean: Infinity };
  for (let i = 0; i + 2 < day.length; i++) {
    const mean = (day[i].value + day[i + 1].value + day[i + 2].value) / 3;
    if (mean < best.mean) best = { start: day[i].hour, mean };
  }
  const fmt = (h: number) => {
    const suffix = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${suffix}`;
  };
  return `${fmt(best.start)}–${fmt(best.start + 3)}`;
}

export default function HomeScreen() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [todayIso, setTodayIso] = useState<string>("");
  const [stations, setStations] = useState<StationRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showStations, setShowStations] = useState(false);
  /** The point under the cursor, shown in the Forecast card's header. */
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) {
      router.replace("/setup");
      return;
    }
    setPrefs(p);

    const q = placeQuery(p, {
      pollutant: p.measurement,
      // TWO DAYS, NOT FIVE. The home chart is the next 24 hours now, which
      // crosses midnight and therefore needs tomorrow; the "Tomorrow:" line
      // below it needs the same day's total. Nothing here needs five.
      days: 2,
      hourly: "true",
      include_today: "true",
    });
    fetch(`/api/forecast?${q}`)
      .then((r) => r.json())
      .then((b) => {
        if (b?.error) {
          setError(b.error.message);
          return;
        }
        setDays(b.data.days ?? []);
        setTodayIso(b.data.today ?? "");
        setStations(b.meta?.stations ?? []);
      })
      .catch(() => setError("Could not reach the server."));
  }, [router]);

  if (!prefs) return <p className="text-gray-500">Loading…</p>;

  const unit = MEASUREMENT_COPY[prefs.measurement].unit;
  const short = MEASUREMENT_COPY[prefs.measurement].short;

  const today = days?.find((d) => d.target_date === todayIso) ?? days?.[0] ?? null;
  const tomorrow = days?.find((d) => d.target_date !== (today?.target_date ?? "")) ?? null;

  // THE NEXT 24 HOURS, not the next seven days. A week of diurnal curve on
  // the screen someone opens to decide about this afternoon was, in a
  // tester's words, too complex for the home tab — five rises and five falls,
  // most of them seasonal averages rather than forecasts. The week is still
  // one tap away on Trends, which exists for exactly that question.
  const points: ForecastDayInput[] = nextDayPoints(days ?? [], todayIso);

  const cleanest = cleanestWindow(today?.hourly ?? null);

  return (
    // TWO COLUMNS ON A LAPTOP, one on a phone. The same cards in the same
    // order, laid out side by side instead of stacked — nothing is added for
    // the bigger screen, because a dashboard with more things on it than the
    // phone has would be a second product to keep correct.
    // MORE SPACE BETWEEN CARDS (was space-y-3), now that there are fewer of
    // them: the screen no longer has to squeeze a map in.
    <div className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
      <h1 className="text-2xl font-bold tracking-tight lg:col-span-2">{APP_NAME}</h1>

      {/* AT THE TOP, not at the bottom of the page. Someone looking at this in
          a phone browser is the person who most needs to know it installs, and
          at the foot of the screen — below the forecast and a map — it was
          past the fold and nobody saw it. It renders nothing at all once the
          app is installed, or once dismissed, so the cost to everyone else is
          zero. */}
      <div className="lg:col-span-2">
        <InstallHint />
      </div>

      {/* The question box leads, because it is the thing this app does that
          nothing else does. */}
      {/* LOOKS LIKE A BUTTON NOW. As a white card with a grey border among
          other white cards with grey borders, it read as a heading rather
          than a control — a tester did not realise it was tappable. Filled,
          with a chevron, because the one affordance everyone recognises is
          something that looks pressable. */}
      <Link
        href="/ask"
        className="flex items-center justify-between gap-3 rounded-xl bg-blue-600 px-4 py-3.5 text-left shadow-sm transition hover:bg-blue-700 lg:col-span-2"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold text-white">
            Ask AI: When should I go out?
          </span>
          <span className="mt-0.5 block text-xs text-blue-100">
            Suggestions based on {short} data
          </span>
        </span>
        <svg
          viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-blue-100"
          fill="none" stroke="currentColor" strokeWidth={2.2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </Link>

      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 lg:col-span-2">{error}</p>
      )}

      {/* EXPECTED TODAY, sized from the September sketch: a small centred box
          carrying the number and the place, not a full-width card with three
          lines of explanation. Measured off the mockup, this is about 15% of
          the screen against the forecast's 29% and the map's 28% — the number
          is the headline, and the sentence about three nearest stations is
          support that belongs behind the info button. */}
      {today && (
        <section className="flex flex-col items-center">
          <div
            className="flex min-w-[8.5rem] flex-col items-center justify-center rounded-2xl px-7 py-3"
            style={{ backgroundColor: today.band.color, color: today.band.textColor }}
          >
            <span className="text-4xl font-bold leading-none">{Math.round(today.value)}</span>
            <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide">
              {today.band.label}
            </span>
          </div>

          {/* THE SCALE, under the number. See components/BandLegend for why
              this belongs on the home screen rather than an explainer page:
              almost nobody knows where the PM2.5 band boundaries are, so a
              green box with 52 in it is unreadable on its own. */}
          <div className="mt-2 w-full max-w-[16rem]">
            <BandLegend measurement={prefs.measurement} value={today.value} />
          </div>

          <div className="mt-2 flex items-center gap-1.5 text-sm">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s-7-5.2-7-11a7 7 0 1 1 14 0c0 5.8-7 11-7 11z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
            <span className="min-w-0 truncate font-medium text-gray-900">
              {prefs.anchor.name}
            </span>
            <button
              type="button"
              onClick={() => setShowStations((v) => !v)}
              aria-label="Which stations?"
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-gray-400 text-[10px] font-semibold text-gray-600"
            >
              i
            </button>
            <Link href="/settings" className="shrink-0 text-blue-700 underline">
              Change
            </Link>
          </div>

          {showStations && (
            <div className="mt-2 w-full rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600">
              <p>
                {short} today, averaged over the {stations.length || NEAREST_K} nearest
                monitoring stations:
              </p>
              <ul className="mt-2 space-y-1">
                {stations.map((st) => (
                  <li key={st.monitor_id} className="flex justify-between gap-3">
                    <span className="truncate">{st.name}</span>
                    <span className="shrink-0 tabular-nums">{st.distance_km.toFixed(1)} km</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Forecast. */}
      {points.length >= 2 && (
        <section className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Next 24 hours</h2>
            {/* The hovered reading lives here, in the gap that was empty
                anyway, instead of in a box on top of the line. */}
            <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-gray-900">
              {hovered}
            </span>
            <span className="shrink-0 text-xs text-gray-500">
              {short}
              {unit ? ` · ${unit}` : ""}
            </span>
          </div>
          <div className="mt-1.5">
            <ForecastChart
              days={points}
              unit={unit}
              onHover={setHovered}
              hourAxis
              /* TALLER AGAIN (was 19vh). It was shrunk so the map would fit on
                 one screen; with the map gone the forecast takes the room back,
                 and a taller plot shows more of the day's rise and fall. */
              heightClass="h-[26vh] min-h-[150px] max-h-[240px]"
            />
          </div>

          {/* NO RED THRESHOLD WARNING. It was the visible half of a setup
              question that has gone — nobody is asked for a threshold now,
              because the notifications it was for do not exist yet. A line
              turning red against a number the person was never asked for
              would be alarming and unexplainable. */}
          {tomorrow && (
            <p className="mt-3 border-t border-gray-100 pt-2.5 text-sm text-gray-900">
              <span className="font-semibold">Tomorrow:</span>{" "}
              {describeChange(today?.value ?? null, tomorrow.value)}.
            </p>
          )}
          {cleanest && (
            <p className="mt-1 text-sm text-gray-600">
              Cleanest hours today: <span className="font-medium text-gray-900">{cleanest}</span>
            </p>
          )}
        </section>
      )}

      {/* SHARE AIRGYAAN, under the forecast card: the app itself — a line
          about it and the install link, no forecast. Sharing a particular
          chart is what the Trends and Ask buttons are for. Shown even when the
          forecast has not loaded, since it does not depend on it. */}
      <div className="-mt-2 flex justify-center">
        <ShareButton label="Share AirGyaan" build={async () => ({ text: APP_SHARE_TEXT })} />
      </div>

    </div>
  );
}
