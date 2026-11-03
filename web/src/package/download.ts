// What the side panel's downloads share: the span of the talk so far, waiting for held tracks to be subscribed,
// gathering a transcript per language over its history (without moving the playhead), the cost guard of the room,
// and handing the browser a file to save.

import { SLICE_MS } from "../contracts/types";
import type { TrackView } from "../playback/aiTracks";
import type { Playback, PlaybackView } from "../playback/playback";
import type { Outline, SlideItem } from "../playback/wire";
import type { PlayerCtx } from "../player/context";
import { languageOption } from "../player/languages";
import type { TranscriptLanguage } from "../player/transcriptExport";
import { MoqTransport } from "../transport/moq";
import type { LanguageGuard } from "./languages";

/** The talk so far in room ms, [from, to); undefined before anything plays. */
export function talkSpan(view: PlaybackView, playback: Playback): { from: number; to: number } | undefined {
  const t = view.timeline;
  const from = t.start;
  const to = Math.max(playback.liveEdge() ?? 0, t.available.at(-1)?.end ?? 0, t.liveEdge ?? 0) + 1;
  return to > from ? { from, to } : undefined;
}

const trackView = (playback: Playback, id: string) => playback.tracks.getSnapshot().tracks.find((t) => t.id === id);

/** Wait until these tracks are subscribed (the player turns them on after the next render), at most `ms`. */
export async function subscribed(playback: Playback, ids: readonly string[], ms = 3_000): Promise<void> {
  const ready = () => ids.every((id) => trackView(playback, id)?.enabled === true);
  for (let i = 0; i < ms / 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
}

/** The outline track's newest snapshot once it arrives on its subscription, at most `ms`. */
export async function outlineOf(playback: Playback, id: string, ms = 4_000): Promise<Outline | undefined> {
  for (let i = 0; i < ms / 100; i++) {
    const outline = trackView(playback, id)?.outline;
    if (outline) return outline;
    await new Promise((r) => setTimeout(r, 100));
  }
  return trackView(playback, id)?.outline;
}

/** "English (original)", "Español". */
export function languageName(lang: string | undefined, original: boolean): string {
  const key = `${lang ?? "en"}|${original}`;
  let name = downloadNames.get(key);
  if (name === undefined) {
    const o = languageOption(lang ?? "en");
    name = original ? `${o.autonym} (original)` : o.autonym;
    downloadNames.set(key, name);
  }
  return name;
}

const downloadNames = new Map<string, string>();

/** Each language's lines over the span, from the tracks' history; the tracks must be held while this runs. */
export function gatherTranscripts(
  playback: Playback,
  wanted: readonly { track: TrackView; original: boolean }[],
  span: { from: number; to: number },
): Promise<TranscriptLanguage[]> {
  const slices = Math.ceil((span.to - span.from) / SLICE_MS) + 2;
  return Promise.all(
    wanted.map(async ({ track, original }) => ({
      lang: track.lang ?? "und",
      name: languageName(track.lang, original),
      lines: await playback.tracks.transcript(track.id, span.from, span.to, slices),
    })),
  );
}

/** The describe agent's slide descriptions over the span, from its history; the track must be held while this runs. */
export function gatherDescriptions(
  playback: Playback,
  track: TrackView,
  span: { from: number; to: number },
): Promise<SlideItem[]> {
  return playback.tracks.descriptions(track.id, span.from, span.to, Math.ceil((span.to - span.from) / SLICE_MS) + 2);
}

/** The room's cost guard: its catalog, and whether a real relay (and so paid agents) is behind it. */
export function guardOf(ctx: Pick<PlayerCtx, "media" | "transport" | "roomName">): LanguageGuard {
  return {
    catalog: ctx.media?.catalog(),
    room: ctx.roomName,
    offline: !(ctx.transport instanceof MoqTransport),
  };
}

/** Hand the browser a file to save. */
export function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
