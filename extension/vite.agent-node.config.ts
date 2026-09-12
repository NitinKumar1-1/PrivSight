/**
 * Development-only build: the real agent controller (with the task guard and
 * completion verifier) as a Node ES module, so scripts/run-agent.mjs can run
 * the actual OBSERVE -> SANITIZE -> REASON -> VALIDATE/EXECUTE -> VERIFY loop
 * against live websites through Playwright. Nothing here ships in dist/.
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist-agent-node",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/agent/controller.ts"),
      formats: ["es"],
      fileName: () => "controller.js",
    },
    rollupOptions: { external: [] },
  },
});
