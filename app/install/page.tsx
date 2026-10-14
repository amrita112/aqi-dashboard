/**
 * /install — the share link.
 *
 * A server shell so it can carry its own metadata, around a client component
 * that has to run in the browser to know anything about installing.
 */

import type { Metadata } from "next";
import InstallScreen from "@/components/InstallScreen";
import { APP_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Install ${APP_NAME}`,
  description: `Add ${APP_NAME} to your home screen, or open it in your browser.`,
};

export default function InstallPage() {
  return <InstallScreen />;
}
