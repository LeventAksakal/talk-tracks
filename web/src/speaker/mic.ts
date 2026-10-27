import { AUDIO_TRACK, teacherPath } from "../contracts/names";
import type { MoqTransport } from "../transport/moq";

export interface MicHandle {
  close(): void;
}

/**
 * Publish the microphone on talk/<room>/teacher with @moq/publish: a hang broadcast (catalog.json)
 * whose track `audio` carries Opus in the legacy container, one 20 ms frame per group (a varint
 * media time in µs, then the packet), which is what the caption agent reads. Encoding only runs
 * while someone (the caption agent) subscribes. Loaded on demand: the library is large.
 */
export async function startMic(
  transport: MoqTransport,
  room: string,
  onError: (error: Error) => void,
): Promise<MicHandle> {
  const Publish = await import("@moq/publish");
  const broadcast = new Publish.Broadcast({
    origin: transport.origin,
    enabled: true,
    announce: true,
    name: Publish.Net.Path.from(teacherPath(room)),
  });
  const microphone = new Publish.Source.Microphone({ enabled: true });
  const source = new Publish.Signals.Computed((effect) => effect.get(microphone.out.source)?.audio);
  const capture = new Publish.Audio.Capture({ source, channelCount: 1 });
  const encoder = new Publish.Audio.Encoder(AUDIO_TRACK, { broadcast, capture, enabled: true });
  const stopError = microphone.out.error.subscribe((e) => {
    if (e) onError(e);
  });
  return {
    close() {
      stopError();
      encoder.close();
      capture.close();
      microphone.close();
      source.close();
      broadcast.close();
    },
  };
}
