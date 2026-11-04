import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const archive = env.TT_ARCHIVE_URL;
// The room service's HTTP endpoints (POST /api/rooms, decision 0025), same origin as the app the way Caddy serves
// them on the VM. Listeners' WebSockets still go straight to :8091 in development (annotate/client.ts).
const roomService = env.TT_ROOM_SERVICE_URL || "http://localhost:8091";

// Link previews need the social card's absolute URL: set TT_SITE_URL to the deployment's origin when building for it
// (never committed, the repo is public). Unset, index.html's %TT_SITE_URL% is empty and the URLs stay relative.
const siteUrl = (env.TT_SITE_URL ?? "").replace(/\/+$/, "");

export default defineConfig({
  plugins: [
    react(),
    { name: "tt-site-url", transformIndexHtml: (html: string) => html.replaceAll("%TT_SITE_URL%", siteUrl) },
  ],
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
  // Routes are split (App.tsx, routes.ts): the hub's entry is about 250 KB (80 KB gzipped). The largest chunk is
  // hls.js (575 KB), already a chunk of its own; warn if anything grows past it.
  build: { chunkSizeWarningLimit: 600 },
  // PowerPoint test fixtures (speaker/fixtures) are read as assets.
  assetsInclude: ["**/*.pptx"],
  test: {
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
