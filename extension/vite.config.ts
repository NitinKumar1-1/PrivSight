import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Popup and service worker build.
 *
 *   popup/popup.html -> dist/popup/popup.html + dist/popup.js
 *   background       -> dist/background.js
 *
 * The content script is built separately by vite.content.config.ts so it is
 * always a single self-contained file: it shares the privacy modules with the
 * service worker, and a content script cannot load ES module chunks.
 */
export default defineConfig({
  root: "src",
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
