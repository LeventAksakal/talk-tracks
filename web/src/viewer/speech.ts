import { useMemo } from "react";

export interface Speech {
  supported: boolean;
  /** Call from a user gesture: some browsers only speak after one. */
  unlock(): void;
  speak(text: string, lang?: string): void;
  cancel(): void;
}

/** Read-aloud through the Web Speech API (speechSynthesis), started by a user gesture. */
export function useSpeech(): Speech {
  return useMemo(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      return { supported: false, unlock() {}, speak() {}, cancel() {} };
    }
    return {
      supported: true,
      unlock() {
        // An empty utterance inside the gesture lets later, automatic ones play (Safari, Chrome on Android).
        synth.speak(new SpeechSynthesisUtterance(""));
      },
      speak(text: string, lang?: string) {
        const u = new SpeechSynthesisUtterance(text);
        if (lang) u.lang = lang;
        synth.speak(u);
      },
      cancel() {
        synth.cancel();
      },
    };
  }, []);
}
