// How the speaker console encodes video once it publishes some (whether it does is the UI lane's call).
// @moq/publish 0.5.3 treats `codec` as a prefix filter: "avc1" picks H.264 (High, then Main, then
// Baseline) instead of the VP9 hardware encoders prefer, so the archive's fMP4 plays in every browser.
// A keyframe every 4 s lines up with the 4 s slices: every slice can start playback on its own.

/** The video `Config` for @moq/publish. */
export const SPEAKER_VIDEO_ENCODER = { codec: "avc1", keyframeInterval: 4_000 } as const;
