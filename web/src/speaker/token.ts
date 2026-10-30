// Pre-flight look at the speaker's token (decision 0005, wiki/howto/tokens.md): moq's auth server
// signs `{publish: [...], subscribe: [...], exp}`. Only the relay can verify the signature; this says
// early whether the token is missing, expired or for another room. The real proof is the relay
// carrying our own audio back (onair.ts).

import { slidesPath, teacherPath } from "../contracts/names";

export type TokenCheck =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "expired"; at: number }
  | { kind: "wrong-room"; missing: string[] }
  | { kind: "ok"; expires: number | undefined };

function claimsOf(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    return json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** moq-token path patterns: `*` one segment, `**` any depth (including none), else literal. */
export function patternCovers(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const match = (i: number, j: number): boolean => {
    if (i === p.length) return j === s.length;
    if (p[i] === "**") return match(i + 1, j) || (j < s.length && match(i, j + 1));
    return j < s.length && (p[i] === "*" || p[i] === s[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];

export function checkToken(token: string | undefined, room: string, nowMs = Date.now()): TokenCheck {
  if (!token) return { kind: "none" };
  const claims = claimsOf(token);
  if (!claims) return { kind: "unreadable" };
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  if (exp !== undefined && exp <= nowMs) return { kind: "expired", at: exp };
  const root = typeof claims.root === "string" ? claims.root.replace(/\/+$/, "") : "";
  const publish = [...list(claims.publish), ...list(claims.put), ...list(claims.pub)].map((p) =>
    root ? `${root}/${p.replace(/^\/+/, "")}` : p,
  );
  const missing = [teacherPath(room), slidesPath(room)].filter((path) => !publish.some((p) => patternCovers(p, path)));
  return missing.length ? { kind: "wrong-room", missing } : { kind: "ok", expires: exp };
}
