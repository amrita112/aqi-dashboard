/**
 * Deciding when two city requests are for the same place -- the app's copy.
 *
 * People type the place themselves, so "Brahmapur", "Brahmapur, Odisha" and
 * "Berhampur" all arrive for one city. The live count in the city-request
 * form must treat them as one, exactly as the alert job does.
 *
 * THE RULE EXISTS IN TWO LANGUAGES, ON PURPOSE: here (for the form's count,
 * on Vercel) and in scripts/alerts/place_names.py (for the alert job, in
 * Python). They cannot drift apart unnoticed because both are tested against
 * one cases file, tests/fixtures/place_names/cases.json
 * (tests/api/place-names.test.ts and tests/test_threshold_alerts.py), and
 * both read the one alias file, lib/place-aliases.json.
 *
 * Two steps:
 *   1. basicPlace(): Unicode-normalise (NFKC: full-width and look-alike
 *      characters become their plain form), lowercase, cut at the first comma
 *      or "(" (drops the state), anything that is not a letter, combining mark
 *      or digit becomes a space, runs of spaces become one.
 *      This is what is STORED on each request (city_requests.place_key,
 *      migration 29).
 *   2. canonicalPlace(): look step 1's result up in the alias file
 *      ("berhampur" -> "brahmapur"). Aliases are applied when COUNTING, never
 *      stored, so editing the alias file changes the counts straight away
 *      without touching the database.
 */

import aliasFile from "./place-aliases.json";

/** Anything that is not a Letter, Mark or Number in Unicode terms. Marks
 *  matter: the vowel signs and viramas of Devanagari, Odia etc. are marks,
 *  and dropping them would break "ब्रह्मपुर" apart. Python says the same
 *  thing with unicodedata.category(). Built with `new RegExp` because this
 *  project's TypeScript target predates the `u` flag in regex literals;
 *  every browser and Node version we run supports it. */
const NOT_LETTER_MARK_DIGIT = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");

/** Step 1: case, state suffix, punctuation and spacing. "" if nothing is left. */
export function basicPlace(name: string): string {
  // toLowerCase, not a locale-aware lowercase: Python's .lower() is the
  // locale-free Unicode mapping too, and the two must agree.
  const text = (name ?? "").normalize("NFKC").toLowerCase();
  const beforeComma = text.split(/[,(]/, 1)[0];
  return beforeComma.replace(NOT_LETTER_MARK_DIGIT, " ").trim().split(/ +/).join(" ");
}

/**
 * The alias file, with both sides passed through basicPlace() so the file
 * can be written in any capitalisation. Throws on a chain (a canonical name
 * that is also listed as a variant), as the Python loader does.
 */
export function loadAliases(raw: { aliases?: Record<string, string> } = aliasFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const [variant, canonical] of Object.entries(raw.aliases ?? {})) {
    map.set(basicPlace(variant), basicPlace(canonical));
  }
  const chained = Array.from(new Set(map.values())).filter((v) => map.has(v) && map.get(v) !== v);
  if (chained.length > 0) {
    throw new Error(`place-aliases.json: these canonical names are also listed as variants: ${chained.sort()}`);
  }
  return map;
}

const ALIASES = loadAliases();

/** Step 2: the key a request is counted under. */
export function canonicalPlace(name: string, aliases: Map<string, string> = ALIASES): string {
  const key = basicPlace(name);
  return aliases.get(key) ?? key;
}

/**
 * Every stored key (step 1 result) that counts towards the same place as
 * `name`: the canonical name plus every variant the alias file sends to it.
 * "Berhampur" -> ["behrampur", "berhampur", "brahmapur", "brahmpur"].
 * This is what the app sends to city_request_count_for(). [] if the name has
 * nothing left after step 1 (e.g. ",,,").
 */
export function placeKeyGroup(name: string, aliases: Map<string, string> = ALIASES): string[] {
  const canonical = canonicalPlace(name, aliases);
  if (!canonical) return [];
  const group = new Set([canonical]);
  aliases.forEach((target, variant) => {
    if (target === canonical) group.add(variant);
  });
  return Array.from(group).sort();
}
