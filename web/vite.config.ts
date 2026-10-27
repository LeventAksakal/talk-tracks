import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The JSON Schemas live in ../contracts and are imported directly, never copied.
  server: { fs: { allow: [".."] } },
  // Astryx ships one barrel module, so the app chunk is about 0.9 MB (0.26 MB gzipped).
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
