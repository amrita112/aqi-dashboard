/**
 * Root Layout — the outer shell that wraps every page.
 *
 * This is like a template: the Navbar appears at the top of every page,
 * and the page content ({children}) is rendered below it.
 * In Next.js, every page automatically gets wrapped by this layout.
 */

import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Navbar from "@/components/Navbar";
import TabBar from "@/components/TabBar";

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
  title: "Air quality for seven Indian cities",
  description: "Tomorrow's air where you are, built from the public monitoring network.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50`}
      >
        <Navbar />
        {/* pb-20 so a fixed bottom bar never covers the last card on a page.
            TabBar renders nothing outside the forecast app, where the padding
            is harmless. */}
        <div className="pb-20">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
