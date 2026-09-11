import { defineConfig } from "vitest/config";

/** Phase 5 SIH evaluation harness (real OCR + real DOM pipeline over rendered fixtures). `npm run eval`. */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["evaluation/scripts/**/*.eval.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
