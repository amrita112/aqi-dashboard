/**
 * Root Layout — the outer shell that wraps every page.
 *
 * Carries the four things every screen needs and no screen should have to ask
 * for: the tab bar, the service worker registration, page-view analytics, and
 * the global error reporter. Everything else belongs to a route.
 */

import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import TabBar from "@/components/TabBar";
import ErrorReporter from "@/components/ErrorReporter";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import { Analytics } from "@vercel/analytics/next";
import { APP_NAME, APP_DESCRIPTION, THEME_COLOR } from "@/lib/brand";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  // "%s · <APP_NAME>" on every page that sets its own title. iOS takes the
  // home-screen label from here, truncated hard, which is why the app name
  // goes last rather than first.
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.png",
    // iOS ignores the manifest's icon list entirely and uses this.
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    // "default" keeps the status bar legible against a light page. The
    // translucent option would put dark text over the app's own content.
    statusBarStyle: "default",
  },
  formatDetection: {
    // Station names contain digits that iOS otherwise turns into phone links.
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  // viewport-fit=cover lets the tab bar reach the bottom of an iPhone screen;
  // it pads itself clear of the home indicator with env(safe-area-inset-bottom).
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-IN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50`}
      >
        {/* pb-20 clears the fixed bottom bar on a phone; lg:pl-56 clears the
            sidebar it becomes on a laptop. Both are harmless on the pages
            where TabBar renders nothing — padding against a bar that is not
            there costs only space. */}
        <div className="pb-20 lg:pb-8 lg:pl-56">{children}</div>
        <TabBar />
        <ServiceWorkerRegistration />
        {/* Catches what app/error.tsx cannot: event handlers, unawaited
            promises, timer callbacks. Renders nothing. */}
        <ErrorReporter />
        {/* Cookieless and identifier-free, so no consent banner and nothing
            that follows anyone between visits. Page views alone answer "which
            tab do people use", because every tab is a real route. */}
        <Analytics />
      </body>
    </html>
  );
}
