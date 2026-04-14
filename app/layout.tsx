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
  title: "AQI Dashboard — Crowdsourced Air Quality for India",
  description: "Submit and view crowdsourced AQI readings across India",
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
        {children}
      </body>
    </html>
  );
}
