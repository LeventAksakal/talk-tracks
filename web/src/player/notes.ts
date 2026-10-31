// Bookmarks and typed notes (ui-design §4.6), stamped with the room time and the slide, kept in this
// browser per room, exported as Markdown.

import { useCallback, useEffect, useState } from "react";
import { formatClock } from "../playback/timeline";

export interface Note {
  id: string;
  /** Room ms. */
  at: number;
  /** 1-based slide number on screen then, when known. */
  slide?: number;
  /** Empty for a bookmark. */
  text: string;
}

const key = (room: string) => `tt.notes.v1.${room}`;

function read(room: string): Note[] {
  try {
    const raw = localStorage.getItem(key(room));
    const notes = raw ? (JSON.parse(raw) as Note[]) : [];
    return Array.isArray(notes) ? notes : [];
  } catch {
    return [];
  }
}

function write(room: string, notes: Note[]): void {
  try {
    localStorage.setItem(key(room), JSON.stringify(notes));
  } catch {
    // Kept for this page only.
  }
}

export interface NotesApi {
  notes: Note[];
  add(note: Omit<Note, "id">): void;
  remove(id: string): void;
}

export function useNotes(room: string): NotesApi {
  const [notes, setNotes] = useState(() => read(room));
  useEffect(() => write(room, notes), [room, notes]);
  const add = useCallback((note: Omit<Note, "id">) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setNotes((n) => [...n, { ...note, id }].sort((a, b) => a.at - b.at));
  }, []);
  const remove = useCallback((id: string) => setNotes((n) => n.filter((x) => x.id !== id)), []);
  return { notes, add, remove };
}

export function notesMarkdown(title: string, notes: readonly Note[], clock = formatClock): string {
  const lines = [`# ${title}`, ""];
  for (const n of notes) {
    const where = `${clock(n.at)}${n.slide ? ` · slide ${n.slide}` : ""}`;
    lines.push(n.text ? `- **${where}** ${n.text}` : `- **${where}** ★ Bookmark`);
  }
  return `${lines.join("\n")}\n`;
}
