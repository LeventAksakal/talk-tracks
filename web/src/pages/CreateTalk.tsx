import { Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
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
import { CloseIcon } from "./hub/icons";

type Field = "title" | "speaker" | "room" | "code";

/** What each refusal means, said at the field it is about. */
const ERRORS: Record<CreateRoomError, { field?: Field; message: string }> = {
  slug: { field: "room", message: "Use 3 to 40 lower-case letters, digits or dashes." },
  code: { field: "code", message: "That access code is not known." },
  taken: { field: "room", message: "That room name is taken. Pick another." },
  rate: { message: "Too many tries. Wait a minute and try again." },
  unreachable: { message: "Could not reach the room service. Try again." },
  failed: { message: "The room could not be made. Try again." },
};

export interface CreateTalkProps {
  /** For tests. */
  create?: (request: Parameters<typeof createRoom>[0]) => Promise<CreateRoomResult>;
}

/**
 * Start a talk (J5, decisions 0025 and 0033): one modal with title, speaker, room name and access code, and one
 * primary button. The room service mints the speaker link; its cap is the operator's concern and never shown. Then
 * the private speaker link, the audience link with its QR, and the way into the console.
 */
export function StartTalkDialog({ open, onClose, create }: CreateTalkProps & { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      // The first field, not the close button, takes focus.
      el.querySelector<HTMLInputElement>("input")?.focus();
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="start-dialog"
      aria-labelledby="start-heading"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its panel) closes it.
        if (e.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="start-panel">
          <header className="start-head">
            <h2 id="start-heading" className="start-title">
              Start a talk
            </h2>
            <button type="button" className="start-close" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <CreateTalk create={create} />
        </div>
      ) : null}
    </dialog>
  );
}

/** The form, then the new room's links. */
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
    <form className="start-form" onSubmit={(e) => void submit(e)} aria-label="Start a talk" noValidate>
      <p className="start-lead">You get a private speaker link for the console and an audience link to share.</p>
      <TextInput
        label="Talk title"
        value={title}
        onChange={(v) => setTitle(v)}
        status={status("title")}
        htmlName="title"
      />
      <TextInput
        label="Speaker"
        value={speaker}
        onChange={(v) => setSpeaker(v)}
        status={status("speaker")}
        htmlName="speaker"
        autoComplete="name"
      />
      <div className="start-pair">
        <TextInput
          label="Room name"
          description="Part of the audience link."
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
          description="From the organisers."
          type="password"
          value={code}
          onChange={(v) => setCode(v)}
          status={status("code")}
          htmlName="code"
          autoComplete="off"
        />
      </div>
      {errors.form ? (
        <p className="start-error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="start-foot">
        <p className="start-hint">Have a speaker link already? Paste it into Join a room.</p>
        <Button label="Start" type="submit" variant="primary" size="lg" width="140px" isLoading={busy} />
      </div>
    </form>
  );
}

/** "Paste your speaker link", for the console's pre-flight when the link it was opened with has no valid token. */
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
    <form className="paste-link-form" onSubmit={open} aria-label="Open a speaker link">
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
    <section className="start-created" aria-labelledby="created-heading">
      <h3 id="created-heading" className="start-created-title">
        Room {created.room} is ready
      </h3>
      <div className="start-speaker-link">
        <label htmlFor="speaker-link">Your speaker link</label>
        <div className="start-link-row">
          <input
            id="speaker-link"
            className="start-link-field"
            readOnly
            value={speakerUrl}
            onFocus={(e) => e.target.select()}
          />
          <Button label="Copy speaker link" size="sm" clickAction={copy} />
        </div>
        <p className="start-warning" role="note">
          Keep it private: anyone with it can speak in this room. Save it now; this page does not keep it.
        </p>
        <p className="start-status" role="status">
          {copied === "yes" ? "Speaker link copied." : copied === "no" ? "Could not copy; select the link above." : ""}
        </p>
      </div>
      <Invite room={created.room} />
      <div className="start-foot">
        <Button label="Open console" variant="primary" size="lg" onClick={() => navigate(created.speaker_path)} />
      </div>
    </section>
  );
}
