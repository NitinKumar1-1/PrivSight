import { defineConfig } from "vitest/config";

/**
 * Real-Chrome end-to-end tests: the built extension loaded into the installed
 * Chrome via Playwright, driving the demo pages against the live backend.
 * Needs: `npm run build`, backend on :8000 with a real key. Run with
 * `npm run test:chrome`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.chrome.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
