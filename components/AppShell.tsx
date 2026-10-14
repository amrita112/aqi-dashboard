"use client";

/**
 * Reserves the space the fixed tab bar occupies — and only when it is there.
 *
 * See components/useTabBar for why this is not just a class on the layout.
 */

import { useTabBarVisible } from "@/components/useTabBar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const hasBar = useTabBarVisible();
  return (
    <div className={hasBar ? "pb-20 lg:pb-8 lg:pl-56" : "pb-8"}>{children}</div>
  );
}
