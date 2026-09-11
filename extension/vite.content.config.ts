import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Content script build: one input, so Rollup inlines every import and
 * dist/content.js has no chunk dependencies. Runs after vite.config.ts and
 * must not empty the output directory.
 */
export default defineConfig({
  root: "src",
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: { content: resolve(__dirname, "src/content/index.ts") },
      output: {
        entryFileNames: "[name].js",
        inlineDynamicImports: true,
      },
    },
  },
});
