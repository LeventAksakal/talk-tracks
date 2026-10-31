import { Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useState } from "react";
import { navigate } from "../router";
import { Invite } from "../speaker/Invite";
import {
  type CreatedRoom,
  type CreateRoomError,
  type CreateRoomResult,
  createRoom,
  SLUG_RE,
  slugify,
  speakerPathFrom,
} from "./createRoom";

type Field = "title" | "speaker" | "room" | "code";

/** What each refusal means, said at the field it is about. */
const ERRORS: Record<CreateRoomError, { field?: Field; message: string }> = {
  slug: { field: "room", message: "Use 3 to 40 lower-case letters, digits or dashes." },
  code: { field: "code", message: "That access code is not known." },
  taken: { field: "room", message: "That room name is taken. Pick another." },
  rate: { message: "Too many tries. Wait a minute and try again." },
  unreachable: { message: "Could not reach the room service. Try again, or paste a speaker link below." },
  failed: { message: "The room could not be created. Try again, or paste a speaker link below." },
};

export interface CreateTalkProps {
  /** For tests. */
  create?: (request: Parameters<typeof createRoom>[0]) => Promise<CreateRoomResult>;
}

/**
 * Create talk (J5, decision 0025): title, speaker, room name and access code; the room service mints a capped
 * speaker link. Then the private speaker link, the audience link with its QR, and the way into the console.
 */
export function CreateTalk({ create = createRoom }: CreateTalkProps) {
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [room, setRoom] = useState("");
  const [roomEdited, setRoomEdited] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field | "form", string>>>({});
  const [created, setCreated] = useState<CreatedRoom>();

  const slug = roomEdited ? room : slugify(title);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const want: Partial<Record<Field, string>> = {};
    if (!title.trim()) want.title = "Give the talk a title.";
    if (!speaker.trim()) want.speaker = "Say who is speaking.";
    if (!SLUG_RE.test(slug)) want.room = ERRORS.slug.message;
    if (!code.trim()) want.code = "Enter the access code you were given.";
    setErrors(want);
    if (Object.keys(want).length > 0) return;
    setBusy(true);
    const result = await create({ code: code.trim(), room: slug, title: title.trim(), speaker: speaker.trim() });
    setBusy(false);
    if (result.ok) {
      setCreated(result.created);
      return;
    }
    const { field, message } = ERRORS[result.error];
    setErrors({ [field ?? "form"]: message });
  };

  if (created) return <Created created={created} />;

  const status = (field: Field) => (errors[field] ? { type: "error" as const, message: errors[field] } : undefined);
  return (
    <form className="lobby-form" onSubmit={(e) => void submit(e)} aria-label="Create talk" noValidate>
      <TextInput
        label="Talk title"
        value={title}
        onChange={(v) => setTitle(v)}
        status={status("title")}
        htmlName="title"
      />
      <TextInput
        label="Speaker"
        description="Your name as listeners will see it."
        value={speaker}
        onChange={(v) => setSpeaker(v)}
        status={status("speaker")}
        htmlName="speaker"
        autoComplete="name"
      />
      <TextInput
        label="Room name"
        description="Part of the audience link: lower-case letters, digits and dashes."
        value={slug}
        onChange={(v) => {
          setRoom(v.toLowerCase());
          setRoomEdited(true);
        }}
        status={status("room")}
        htmlName="room"
      />
      <TextInput
        label="Access code"
        description="Presenters get one from the organisers. It caps what the room's AI may spend."
        type="password"
        value={code}
        onChange={(v) => setCode(v)}
        status={status("code")}
        htmlName="code"
        autoComplete="off"
      />
      {errors.form ? (
        <p className="lobby-error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <Button label="Create talk" type="submit" variant="primary" isLoading={busy} />
    </form>
  );
}

/** The new room: the private speaker link first, then the audience link and QR, then into the console. */
function Created({ created }: { created: CreatedRoom }) {
  const speakerUrl = new URL(created.speaker_path, location.origin).toString();
  const [copied, setCopied] = useState<"yes" | "no">();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(speakerUrl);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };
  return (
    <section className="lobby-created" aria-labelledby="created-heading">
      <h3 id="created-heading">Room {created.room} is ready</h3>
      <div className="lobby-speaker-link">
        <label htmlFor="speaker-link">Your speaker link</label>
        <input
          id="speaker-link"
          className="lobby-link-field"
          readOnly
          value={speakerUrl}
          onFocus={(e) => e.target.select()}
        />
        <Button label="Copy speaker link" size="sm" clickAction={copy} />
        <p className="lobby-warning" role="note">
          Keep this link private: anyone who has it can broadcast as the speaker in this room. Save it now; this page
          does not keep it.
        </p>
        <p className="muted small" role="status">
          {copied === "yes" ? "Speaker link copied." : copied === "no" ? "Could not copy; select the link above." : ""}
        </p>
        {Number.isFinite(created.cap_usd) ? (
          <p className="muted small">The room's AI tracks may spend up to ${created.cap_usd.toFixed(2)}.</p>
        ) : null}
      </div>
      <Invite room={created.room} />
      <Button label="Open console" variant="primary" onClick={() => navigate(created.speaker_path)} />
    </section>
  );
}

/** "Paste your speaker link": for a link minted another way (or by this form on another device). */
export function PasteSpeakerLink() {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string>();
  const open = (e?: FormEvent) => {
    e?.preventDefault();
    const path = speakerPathFrom(link);
    if (!path) {
      setError("That is not a speaker link. It looks like …/talk/<room>?token=…");
      return;
    }
    navigate(path);
  };
  return (
    <form className="lobby-inline-form" onSubmit={open} aria-label="Open a speaker link">
      <TextInput
        label="Paste your speaker link"
        value={link}
        onChange={(v) => {
          setLink(v);
          setError(undefined);
        }}
        onEnter={() => open()}
        status={error ? { type: "error", message: error } : undefined}
        htmlName="speaker-link"
        autoComplete="off"
      />
      <Button label="Open speaker link" type="submit" variant="secondary" />
    </form>
  );
}
