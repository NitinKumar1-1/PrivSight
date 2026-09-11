import { defineConfig } from "vitest/config";

/** Live end-to-end tests. Need the backend on :8000 with a real key. Run with `npm run test:e2e`. */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
