// "Create talk" (J5, decision 0025): the room service checks an access code and mints a capped speaker link.
// POST /api/rooms {code, room, title, speaker} → 201 {room, speaker_path, watch_path, cap_usd}. Same origin as the
// app: Caddy proxies /api/ to the room service on the VM, Vite's dev server does locally.

export const CREATE_ROOM_URL = "/api/rooms";

/** Room slugs the endpoint accepts. */
export const SLUG_RE = /^[a-z0-9-]{3,40}$/;

export interface CreateRoomRequest {
  code: string;
  room: string;
  title: string;
  speaker: string;
}

export interface CreatedRoom {
  room: string;
  /** /talk/<room>?token=…: private, it publishes as the speaker. */
  speaker_path: string;
  /** /watch/<room>. */
  watch_path: string;
  /** The room's AI spend cap, US dollars. */
  cap_usd: number;
}

/** Which field a refusal is about, so the form can say it there. */
export type CreateRoomError = "slug" | "code" | "taken" | "rate" | "unreachable" | "failed";

export type CreateRoomResult = { ok: true; created: CreatedRoom } | { ok: false; error: CreateRoomError };

/** A slug from a talk title: lower case, dashes for anything else, at most 40 characters. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const BY_STATUS: Record<number, CreateRoomError> = { 400: "slug", 403: "code", 409: "taken", 429: "rate" };

export async function createRoom(
  request: CreateRoomRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<CreateRoomResult> {
  let res: Response;
  try {
    res = await fetchImpl(CREATE_ROOM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (res.status === 201 || res.ok) {
    try {
      const body = (await res.json()) as Partial<CreatedRoom>;
      if (typeof body.speaker_path === "string" && typeof body.room === "string") {
        return {
          ok: true,
          created: {
            room: body.room,
            speaker_path: body.speaker_path,
            watch_path: typeof body.watch_path === "string" ? body.watch_path : `/watch/${body.room}`,
            cap_usd: typeof body.cap_usd === "number" ? body.cap_usd : Number.NaN,
          },
        };
      }
    } catch {
      // fall through: an answer we cannot read
    }
    return { ok: false, error: "failed" };
  }
  // The dev proxy answers 5xx when the room service is not running.
  if (res.status >= 500) return { ok: false, error: "unreachable" };
  return { ok: false, error: BY_STATUS[res.status] ?? "failed" };
}

/** A pasted speaker link (full URL or path) as the path to open, or null when it is not one. */
export function speakerPathFrom(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text, "http://x");
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "talk" || !/^[a-z0-9-]{3,40}$/.test(parts[1]!)) return null;
  if (!url.searchParams.get("token")) return null;
  return `${url.pathname}${url.search}`;
}
