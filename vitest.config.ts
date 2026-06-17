/**
 * Vitest configuration.
 *
 * - `environment: "happy-dom"` gives tests a lightweight fake browser so React
 *   components can render without a real one.
 * - The `@/` alias mirrors the one in tsconfig.json so test imports look the
 *   same as app imports (e.g., `import { x } from "@/lib/aqi-utils"`).
 * - `setupFiles` runs once before tests to register extra `expect` matchers.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
