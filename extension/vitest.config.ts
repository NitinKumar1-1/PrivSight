import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    // The executor waits real, bounded time for page and cart signals; several such waits can share one test.
    testTimeout: 20000,
  },
});
