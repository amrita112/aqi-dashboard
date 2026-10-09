"use client";

/**
 * One collapsible section of the explainer.
 *
 * A <details> element rather than React state: it is keyboard accessible and
 * findable by the browser's own in-page search without any work, and a reader
 * looking for "where does the data come from" should not fail to find it
 * because the text is hidden behind a div this component forgot to open.
 *
 * `defaultOpen` on the first section, so the page does not open as a list of
 * closed boxes with nothing to read.
 */

export default function Collapsible({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group border-b border-gray-200 py-4 [&_p]:mt-3 [&_p]:text-gray-700 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:text-gray-700"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-lg font-semibold">
        {title}
        <span
          aria-hidden
          className="shrink-0 text-gray-400 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      {children}
    </details>
  );
}
