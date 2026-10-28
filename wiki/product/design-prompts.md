# Prompts for the Claude Design session (2026-10-28)

Paste these in order into Claude Design, with [design-brief.md](design-brief.md) uploaded. Prompt 1 sets the
direction; each later prompt is one screen. Change the direction in prompt 1 if the owner picks another concept
(brief §6, §8).

## 1. Direction and design language

> You are designing Talk Tracks, a live-lecture web app. Read the attached design brief first; it is the source of
> truth for users, screens, states, features and constraints.
>
> Direction: the **multitrack timeline**. The AI features are tracks a viewer composes, shown as lanes under the
> stage the way a video editor shows its lanes. Switching a track on makes its lane slide in and fill from "now";
> scrubbing moves the media and every lane together; the live edge is a bright line with a LIVE badge.
>
> Start with the design language, before any screen: propose 3 distinct directions (A/B/C) as small style tiles,
> each with a light and a dark palette (WCAG AA contrast checked and stated), a type scale and font pairing, spacing
> and radius scale, the LIVE accent, the caption styles (normal, large, high contrast yellow on black), and a
> motion note (respecting reduced motion). The app uses Meta's Astryx design system for standard controls (switch,
> button, badge, text input, tabs), so the tiles should show those controls themed. Recommend one and say why.

## 2. Student viewer, desktop

> Design the student viewer at 1440 × 900 in the chosen language. Stage (speaker video or the current slide, with a
> caption overlay) on top; the multitrack timeline under it with lanes for each opted-in track, chapter marks, slide
> change marks and glossary ticks; a track list beside the lanes (name, switch, status, one-line explanation); a
> side panel with tabs for Transcript, Slides, Outline (chapters, glossary, recap) and Notes.
>
> Show three variants of the layout (A/B/C), then these states for the recommended one: first visit with every track
> off (with an onboarding nudge to switch on captions); live with captions and Turkish on; rewound 4:30 behind live
> with the grey LIVE badge and "Go live −04:30"; just returned to live with a "What you missed" card (2 chapters,
> "show transcript"); a track that is starting; a track that is capped by the room's spend limit.

## 3. Student viewer, phone

> Design the same viewer at 375 × 812, as a first-class layout, not a reduced one. Stage on top with captions; a
> single scrubber with chapter marks and a Go live pill; swipeable tabs below (Captions, Transcript, Slides,
> Outline, Notes); the track list as a bottom sheet. Show: first visit, live with captions, rewound, "What you
> missed", the open tracks sheet, and landscape with the stage full screen and captions overlaid. Touch targets at
> least 44 px. Note that iPhones use a slower WebSocket path: show how the delay is stated honestly.

## 4. Tracks panel and opt-in

> Design the track list in detail, desktop and phone: each track's switch, status (off, starting, live, 4 s behind,
> stale, capped, back-filling earlier slices), a one-line explanation ("Live captions from the teacher's voice"),
> and for Turkish an option to show it beside, under, or instead of the English. Make it obvious that a track is off
> until you switch it on and that switching it off stops it. Include a compact preset row ("Follow along",
> "Accessible", "Türkçe") if it helps first-time users, and say whether you recommend it.

## 5. Rewind, Go live and what you missed

> Design the timeline interactions: hover/scrub preview (time, chapter title, slide thumbnail), keyboard control
> (arrows step 5 s, J/L 10 s, Home to start, End or G to go live), seeking while slices load (lanes show loading),
> holes where nobody broadcast, and media unavailable while the AI tracks still rewind. Then the "What you missed"
> card for three triggers (came back to live, tab was hidden for 6 minutes, reconnected), with the outline track on
> and off.

## 6. Transcript, glossary and notes

> Design the transcript tab: follows live with auto-scroll and a "Jump to latest" chip when the reader scrolls up;
> search; click a line to rewind there; English and Turkish side by side or interleaved; glossary terms underlined
> with a definition popover and "first mentioned at 12:40"; a slide description shown inline where the slide
> changed. Then the notes tab: B bookmarks the moment, selecting a line makes a note, each note shows its time and
> slide thumbnail, and an "Export as Markdown" action. Notes stay in the browser.

## 7. Accessibility pass

> Review the viewer designs for a blind student using a screen reader and for a low-vision student at 200 % zoom.
> Show the focus order, the landmarks and headings, what is announced and when (new slide descriptions politely;
> never every caption word), the "Read slides aloud" control, the caption size and contrast settings, and the
> layout at 200 % zoom on desktop. Fix anything in earlier screens that fails WCAG 2.2 AA.

## 8. Speaker console

> First settle brief §8 question 8 (camera, screen share, both, or audio and slides only); design the console and
> the viewer's stage for that choice.
>
> Design the teacher's console at 1440 × 900: mic and camera preview with levels, a big On air / Off air control,
> slide upload and next/previous, the share link and a QR code for phones, and a track meter: each track, whether
> its agent is producing, how many viewers have it on, and the room's spend against its cap. States: before going
> on air (permissions), on air, mic missing or blocked, device clock error, reconnecting, room capped.

## 9. Landing, join and the teacher's entry

> Design the landing page: a short explanation of the idea (tracks you switch on, rewind with every track in sync),
> two demo lecture cards (biology; data visualisation; both CC BY-SA talks from EMF, credited), a "Join a room" box
> (room name or link; QR scan on phones), and "I'm teaching" for a teacher who has a publishing link from the
> organiser (a browser cannot create one). Also the 404 and "room not found / waiting for the teacher" pages.

## 10. Judge inspector and offline demo

> Design the judge inspector as a toggle-able panel in the viewer: for each track, producing or idle, the FETCHes the
> agent served as origin against this viewer's own FETCHes (the difference is the relay's cache), back-fills and
> spend; plus a small live diagram of the subscription chain (viewer → relay → agent, translation and chapters
> subscribing to captions). Keep it readable for a judge who has 10 seconds. Then the offline demo page: the same
> viewer with a clear "Offline demo, scripted, no network" label.

## 11. Hand-back

> Summarise the decisions for the build: the chosen direction and variants per screen, the design tokens as a table
> (light and dark), the components we need beyond Astryx's standard ones, and anything you cut. Export what you can
> as HTML/CSS.
