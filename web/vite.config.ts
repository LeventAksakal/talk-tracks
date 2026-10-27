import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The JSON Schemas live in ../contracts and are imported directly, never copied.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
