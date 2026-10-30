// The speaker's notes: per slide, kept in this browser only (keyed by the PDF's fingerprint), never
// published (ui-design §3.4 "private stays local", decision 0018).

import { useCallback, useState } from "react";

const key = (fingerprint: string) => `tt.notes.${fingerprint}`;

export function loadNotes(fingerprint: string | undefined): string[] {
  if (!fingerprint) return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(fingerprint)) ?? "[]");
    return Array.isArray(raw) ? raw.map((n) => (typeof n === "string" ? n : "")) : [];
  } catch {
    return [];
  }
}

function saveNotes(fingerprint: string, notes: string[]): void {
  try {
    localStorage.setItem(key(fingerprint), JSON.stringify(notes));
  } catch {
    // Storage full or blocked: the notes still live for this session.
  }
}

/** Notes of the deck with this fingerprint, and a setter per slide. */
export function useNotes(fingerprint: string | undefined): [string[], (index: number, text: string) => void] {
  const [state, setState] = useState<{ fingerprint: string | undefined; notes: string[] }>(() => ({
    fingerprint,
    notes: loadNotes(fingerprint),
  }));
  const notes = state.fingerprint === fingerprint ? state.notes : loadNotes(fingerprint);
  if (state.fingerprint !== fingerprint) setState({ fingerprint, notes });
  const set = useCallback(
    (index: number, text: string) =>
      setState((s) => {
        const next = [...s.notes];
        while (next.length < index) next.push("");
        next[index] = text;
        if (s.fingerprint) saveNotes(s.fingerprint, next);
        return { ...s, notes: next };
      }),
    [],
  );
  return [notes, set];
}
