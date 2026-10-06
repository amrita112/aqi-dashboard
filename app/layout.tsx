/**
 * Root Layout — the outer shell that wraps every page.
 *
 * Two products share it. The original crowdsourced-readings app keeps the top
 * Navbar; the forecast app uses the bottom TabBar. Each stands down on the
 * other's routes — see lib/nav.ts — so they never stack.
 */

import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Navbar from "@/components/Navbar";
import TabBar from "@/components/TabBar";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
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
  // "%s · Saaf Hawa" on every page that sets its own title. iOS takes the
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
        <Navbar />
        {/* pb-20 so the fixed bottom bar never covers the last card on a page.
            TabBar renders nothing outside the forecast app, where the padding
            is harmless. */}
        <div className="pb-20">{children}</div>
        <TabBar />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
