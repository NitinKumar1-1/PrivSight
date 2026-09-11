import { defineConfig } from "vitest/config";

/** Phase 5 browser benchmark. Needs the backend on :8000 and a built extension. `npm run benchmark`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["evaluation/scripts/**/*.chrome.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
