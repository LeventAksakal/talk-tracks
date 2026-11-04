import { Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useState } from "react";
import { Glyph } from "../brand/Glyph";
import { Modal, ModalBody, ModalFooter } from "../brand/Modal";
import { navigate } from "../router";
import { AudienceLink, ProjectInvite, QrCode, useCopy, watchUrl } from "../speaker/Invite";
import { keepSpeakerLink } from "../speaker/savedToken";
import { rememberSpeakerName, rememberTitle } from "../speaker/talkTitle";
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
  unreachable: { message: "Could not reach the room service. Try again." },
  failed: { message: "The room could not be made. Try again." },
};

export interface CreateTalkProps {
  /** For tests. */
  create?: (request: Parameters<typeof createRoom>[0]) => Promise<CreateRoomResult>;
}

/** The modal's title is the dialog's: the form says when the room is made. */
interface CreateTalkFormProps extends CreateTalkProps {
  onCreated: (created: CreatedRoom) => void;
}

/**
 * Start a talk (J5, decisions 0025 and 0033): one modal with title, speaker, room name and access code, and one
 * primary button in its footer. The room service mints the speaker link; its cap is the operator's concern and never
 * shown. Then the room is ready: its code, the audience link with its QR (and a full-screen card to project), the
 * private speaker link, and the way into the console.
 */
export function StartTalkDialog({ open, onClose, create }: CreateTalkProps & { open: boolean; onClose: () => void }) {
  const [created, setCreated] = useState<CreatedRoom>();
  const close = () => {
    setCreated(undefined);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={created ? "Your talk is ready" : "Start a talk"}
      titleId="start-heading"
      size={created ? "lg" : "md"}
      className="start-dialog"
      // The speaker link is shown once: the ready screen leaves only through its own buttons, never by a stray click.
      dismissible={!created}
    >
      {created ? <Created created={created} onDone={close} /> : <CreateTalk create={create} onCreated={setCreated} />}
    </Modal>
  );
}

/** The form: four fields in the body, Start in the footer. */
export function CreateTalk({ create = createRoom, onCreated }: CreateTalkFormProps) {
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [room, setRoom] = useState("");
  const [roomEdited, setRoomEdited] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field | "form", string>>>({});

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
      rememberTitle(result.created.room, title.trim());
      rememberSpeakerName(speaker);
      keepSpeakerLink(result.created.room, result.created.speaker_path);
      onCreated(result.created);
      return;
    }
    const { field, message } = ERRORS[result.error];
    setErrors({ [field ?? "form"]: message });
  };

  const status = (field: Field) => (errors[field] ? { type: "error" as const, message: errors[field] } : undefined);
  return (
    <form className="start-form" onSubmit={(e) => void submit(e)} aria-label="Start a talk" noValidate>
      <ModalBody className="start-fields">
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
      </ModalBody>
      <ModalFooter note="Have a speaker link already? Paste it into Join a room.">
        <Button label="Start" type="submit" variant="primary" width="120px" isLoading={busy} />
      </ModalFooter>
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

/** The new room: its code, the audience link and QR to share, the private speaker link, then into the console. */
function Created({ created, onDone }: { created: CreatedRoom; onDone: () => void }) {
  const speakerUrl = new URL(created.speaker_path, location.origin).toString();
  const audienceUrl = watchUrl(created.room);
  const { copied, copy } = useCopy(speakerUrl);
  return (
    <>
      <ModalBody className="start-created">
        <figure className="start-qr">
          <QrCode text={audienceUrl} label={`QR code for ${audienceUrl}`} />
          <figcaption>Viewers scan it to watch</figcaption>
          <ProjectInvite room={created.room} />
        </figure>
        <div className="start-links">
          <div className="start-code">
            <span className="start-code-label">Room code</span>
            <span className="start-code-value">{created.room}</span>
          </div>
          <AudienceLink room={created.room} label="Audience link, to share" />
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
              <Button
                label={copied === "yes" ? "Copied" : "Copy speaker link"}
                size="sm"
                variant="secondary"
                icon={<Glyph name={copied === "yes" ? "checkCircle" : "contentCopy"} />}
                clickAction={copy}
              />
            </div>
            <p className="start-warning" role="note">
              <Glyph name="info" />
              Keep it private: anyone with it can speak in this room. This browser keeps it; copy it to speak from
              another device.
            </p>
            <p className="start-status" role="status">
              {copied === "yes" ? "Speaker link copied." : copied === "no" ? "Could not copy; select the link." : ""}
            </p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter note="Nothing goes out until you go on air.">
        {copied === "yes" ? <Button label="Done" variant="secondary" onClick={onDone} /> : null}
        <Button label="Open console" variant="primary" onClick={() => navigate(created.speaker_path)} />
      </ModalFooter>
    </>
  );
}
