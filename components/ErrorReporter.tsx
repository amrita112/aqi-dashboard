"use client";

/**
 * Catches the errors React does not.
 *
 * app/error.tsx handles anything thrown while rendering. It does not see an
 * exception from an event handler, a failed promise nobody awaited, or a
 * `setTimeout` callback — and those are most of what actually breaks a page in
 * practice: a tap handler hitting an undefined field, a fetch rejecting on a
 * flaky connection.
 *
 * Mounted once in the layout. Renders nothing.
 */

import { useEffect } from "react";
import { reportError } from "@/lib/report-error";

export default function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportError(event.error ?? event.message, "window");
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      reportError(event.reason, "unhandled promise");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
