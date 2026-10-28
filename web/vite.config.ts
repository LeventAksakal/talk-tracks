import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const archive = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TT_ARCHIVE_URL;

export default defineConfig({
  plugins: [react()],
  server: {
    // The JSON Schemas live in ../contracts and are imported directly, never copied.
    fs: { allow: [".."] },
    // The track archive, which Caddy serves under /archive/ on the VM: locally, point TT_ARCHIVE_URL at
    // compose's archive-files (http://localhost:8090, wiki/howto/archive.md).
    proxy: archive ? { "/archive": { target: archive, rewrite: (p) => p.replace(/^\/archive/, "") } } : undefined,
  },
  // Astryx ships one barrel module, so the app chunk is about 0.9 MB (0.26 MB gzipped).
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
