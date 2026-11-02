import { defineConfig } from "vite";

// Served from https://kunalshukla-al.github.io/mytube/
export default defineConfig({
  base: "/mytube/",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 800,
  },
});
