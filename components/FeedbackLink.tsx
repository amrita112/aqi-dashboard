/**
 * "Give Feedback": opens the feedback Google Form in a new tab.
 *
 * A LINK, not a button, because it goes somewhere rather than doing something,
 * and a real <a> means long-press, "open in new tab" and screen readers all
 * behave as people expect. Styled to match the Share AirGyaan pill it sits
 * beside, so the two read as a pair.
 *
 * No "use client": nothing here runs in the browser, so it renders on the
 * server and can still be placed inside client screens like HomeScreen.
 */

import { FEEDBACK_FORM_URL } from "@/lib/brand";

export default function FeedbackLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={FEEDBACK_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 ${className}`}
    >
      <FeedbackIcon />
      Give Feedback
    </a>
  );
}

/** A speech bubble, same size and stroke as the share icon beside it. */
function FeedbackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}
