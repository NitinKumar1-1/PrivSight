import { defineConfig } from "vitest/config";

/** SIH evaluation harness: real OCR over real screenshots. Run with `npm run eval`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["eval/**/*.eval.ts", "tests/integration/**/*.int.ts"],
    testTimeout: 180_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
