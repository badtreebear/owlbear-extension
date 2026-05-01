import { defineConfig } from "vite";

// When deployed to GitHub Pages the app lives at /owlbear-extension/
// Locally it lives at /
const base = process.env.GITHUB_ACTIONS ? "/owlbear-extension/" : "/";

export default defineConfig({
  base,
  server: {
    port: 3456,
  },
  build: {
    outDir: "dist",
  },
});
