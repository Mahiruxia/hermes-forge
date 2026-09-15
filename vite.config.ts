import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // Keep shared React/JSX code in the entry graph. Forcing whole dependency
    // groups into manual chunks pulled the Markdown parser into every screen.
    // Route and panel imports provide the lazy-loading boundaries instead.
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
