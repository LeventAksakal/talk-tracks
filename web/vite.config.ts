import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const archive = env.TT_ARCHIVE_URL;
// The room service's HTTP endpoints (POST /api/rooms, decision 0025), same origin as the app the way Caddy serves
// them on the VM. Listeners' WebSockets still go straight to :8091 in development (annotate/client.ts).
const roomService = env.TT_ROOM_SERVICE_URL || "http://localhost:8091";

export default defineConfig({
  plugins: [react()],
  server: {
    // The JSON Schemas live in ../contracts and are imported directly, never copied.
    fs: { allow: [".."] },
    // The track archive, which Caddy serves under /archive/ on the VM: locally, point TT_ARCHIVE_URL at
    // compose's archive-files (http://localhost:8090, wiki/howto/archive.md).
    proxy: {
      "/api": { target: roomService },
      ...(archive ? { "/archive": { target: archive, rewrite: (p: string) => p.replace(/^\/archive/, "") } } : {}),
    },
  },
  // Astryx ships one barrel module, so the app chunk is about 0.9 MB (0.26 MB gzipped).
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
