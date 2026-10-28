# Field research: video, lecture and live-caption products (2026-10-28)

A survey of meeting, webinar, teaching, lecture-capture, streaming, live-caption and engagement products: their viewer
UI, their AI features, and what Talk Tracks can borrow or do better. It feeds the design session and the Product spec
and UI lane (see `inspection-2026-10-28.md`).

**How this was made.** Public product pages, help centres, official docs and official blogs only, read on 2026-10-28;
no sign-in, no forms. Each claim in the product cards carries its source URL. The pattern catalogue and the matrix
summarise those cards and do not repeat the links. Evidence quality varies:

- "(snippet)" marks a claim read from a search-result summary of the cited page, because the page itself would not
  load (Kaltura and Panopto help pages, some Coursera and Echo360 pages). Treat these as less firm.
- "(3rd-party)" marks a claim from press or reviews rather than the vendor.
- "Not found" means the public docs did not say, not that the feature is missing.
- Vendors move fast, and some help pages contradict each other; conflicts are noted where we saw them.

## 1. Summary

- **Per-viewer captions and caption language are standard** (Zoom, Meet, Teams, Webex, Livestorm, Vimeo, Wordly), but each product toggles one feature from one menu. None offers a single panel of independent AI layers.
- **Spoken translation is opt-in per listener**, usually with a slider between original and translated audio (Teams, Webex, Interprefy). No product does AI dubbing inside a large broadcast.
- **AI catch-up is common in meetings but private and on demand**: Zoom "Catch me up", Meet "Summary so far", Teams late-join offer, Webex "last 15 minutes", Engageli. Each works only if the AI was already running.
- **Chapters, summaries and highlights arrive almost only after the session** (Zoom, Teams Recap, Kaltura, Panopto, Echo360, Riverside, YouTube). No product grows chapters live.
- **Live rewind exists** (Vimeo, Teams town halls, Panopto, Kaltura, YouTube DVR) with a "Skip to live" or "Watch Live" button. None re-syncs captions, slides or transcript to the rewound point, and none recaps the stretch you skipped.
- **Interactive transcripts are standard on demand** (click to seek, search, highlight to note: Kaltura, Panopto, edX, Coursera) but rare live (Vimeo, Zoom search, Class).
- **AI barely sees slides.** Only Panopto's slide-text search (OCR), Otter's slide capture, and Slido and Engageli generating polls from slides use them. No product describes slides for blind viewers, and none builds a glossary.
- **Accessibility is mostly caption styling and sign-language video channels; mobile is weak** or undocumented almost everywhere.
- **Gaps Talk Tracks can own:** one tracks panel, rewind with every track in sync plus a recap of the skipped stretch, live chapters anchored to slides, slide descriptions, a live glossary, and live tracks kept with the recording.

## 2. Product cards

### Meetings

#### Zoom (Meetings, Webinars, AI Companion)

- **Layout:**
  - Shared content sits side by side with the speaker or gallery, with a draggable divider, and the webinar host can
    force the attendee view.
  - Side-by-side mode is not available on phones.
  - Captions sit above the toolbar, can pop out as a movable overlay, and label each speaker.
  - AI features open in a panel at the top right.
- **Captions and transcript:**
  - "View full transcript" is a live side panel with search and a .txt save; the host must enable it.
  - Since May 2026 captions can no longer be saved; the transcript is the durable record.
  - The recording transcript is timestamped, searchable and editable.
- **Translation:**
  - The host allows language pairs, and each viewer picks a caption language.
  - Original and translated captions can be shown together.
  - Spoken translation exists only as human interpreter audio channels, with an option to mute the original. No AI
    dubbing was found.
- **AI:**
  - In-meeting questions come with presets ("Catch me up", action items) or free form.
  - The host scopes AI answers to "since you joined" or "whole meeting"; asking works on desktop only.
  - Webinar attendees got "catch me up" in Aug 2025, capped at 1,000 attendees.
  - The summary and smart-recording chapters (editable by the host) arrive after the meeting.
- **Engagement:**
  - Q&A is anonymous-capable, with upvotes and sort by votes.
  - Polls, hand raise (phone users dial *9), and floating reactions that each viewer can hide for themselves.
- **Notes:** private "My Notes" during a meeting. No viewer bookmarks were found.
- **Accessibility:** per-viewer caption font, size and colour, and up to 20 pinned sign-language channels, which are
  missing from recordings.
- **Rewind:** no DVR was found for webinars or events.
- **Borrow:**
  - Scoping AI answers to "since you joined" versus the whole session.
  - A per-viewer opt-out for reactions.
  - An approval flow for caption and translation requests.
  - Original and translated captions shown together.
- **Sources:**
  - Captions, translation request and mobile: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059762
  - Side by side: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067526
  - Not on phones: https://support.zoom.com/hc/ja/article?id=zm_kb&sysparm_article=KB0065528
  - Full transcript: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063899
  - Caption saving removed: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085668
  - Recording transcript: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064927
  - Translated captions: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060844
  - Interpretation: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064768
  - AI Companion in meetings: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0057748
  - Webinar catch-up: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0080361
  - Smart recording: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061101
  - Q&A: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064380
  - Reactions: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059395
  - My Notes: https://support.zoom.com/hc/pl/article?id=zm_kb&sysparm_article=KB0087979
  - Caption styling: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058202
  - Sign language: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066357
  - Host caption controls: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062813

#### Google Meet (Gemini)

- **Layout:**
  - One "Captions and translation" control in the bottom bar holds live captions, translated captions and speech
    translation.
  - "Take notes for me" sits at the top right.
  - Ask Gemini moved to the bottom-left corner on the web in May 2026.
  - Live-stream viewers toggle captions themselves, but the host sets the caption language.
- **Captions and transcript:**
  - Scroll-back covers only the time you had captions on.
  - The transcript is saved as a Doc after the meeting.
  - Gemini notes cite transcript timestamps, but the citations jump to the transcript, not the video.
- **Translation:**
  - Each viewer picks "Translate from" and "Translate to", across 80+ caption languages.
  - Speech translation is speech to speech in a voice like the speaker's, about 75 languages, a few seconds behind.
  - A speaker must opt in to being translated ("Translate me"), and everyone sees when translation is in use.
  - Not in live streams or recordings.
  - Help pages conflict on whether one language pair applies to the whole meeting.
- **AI:**
  - A live "Summary so far" for latecomers; the full notes Doc arrives after the meeting.
  - Ask Gemini gives private in-meeting answers.
  - Catching up on time before you joined works only if notes were already on.
- **Engagement:** Q&A and polls are shared with live-stream viewers. "Moderated contributors" can raise a hand,
  react and take part, and viewer mode serves large meetings.
- **Accessibility:**
  - Caption font, size, colour and background are set per user and saved.
  - Tested with JAWS, NVDA, ZoomText and TalkBack.
  - No dedicated sign-language view, only pinning.
- **Rewind:** none found.
- **Borrow:**
  - One combined captions-and-translation control.
  - A visible badge when translation is active.
  - Notes that cite timestamps (but link them to the video).
  - Private AI answers.
- **Sources:**
  - Captions and translated captions: https://support.google.com/meet/answer/10964115?hl=en
  - Speech translation: https://support.google.com/meet/answer/16221730?hl=en
  - Take notes for me: https://support.google.com/meet/answer/14754931?hl=en
  - Ask Gemini moves bottom-left: https://workspaceupdates.googleblog.com/2026/05/ask-gemini-in-google-meet-is-becoming-more-easily-accessible-on-web.html
  - Ask Gemini launch: https://workspaceupdates.googleblog.com/2025/09/ask-gemini-in-google-meet.html
  - Notes cite transcript: https://workspaceupdates.googleblog.com/2025/02/transcript-citations-take-notes-for-me-google-meet.html
  - Transcript Doc: https://support.google.com/meet/answer/12849897?hl=en
  - Live-stream captions, Q&A and polls: https://support.google.com/meet/answer/14258977?hl=en-419&co=GENIE.Platform%3DDesktop
  - Moderated contributors: https://support.google.com/meet/answer/13658394?hl=en
  - Caption styling: https://workspaceupdates.googleblog.com/2025/06/customizable-caption-styling-for-google-meet.html
  - Screen readers: https://support.google.com/accessibility/answer/16175468?hl=en&co=GENIE.Platform%3DDesktop
  - Speech translation controls: https://workspaceupdates.googleblog.com/2026/01/control-speech-translation-in-meet.html

#### Microsoft Teams (meetings, town halls, Copilot, Interpreter, Education)

- **Layout:**
  - Captions are a per-user toggle in a movable pane; font, size, colour and line count persist.
  - Copilot opens in a right-hand side panel that can pop out on desktop.
  - Town-hall attendees get a watch-only event window. On phones that needs the app; mobile web is not supported.
- **Captions and transcript:**
  - The live transcript pane shows speaker and timestamp, on desktop only.
  - Captions are not saved.
  - No live transcript search was found.
- **Translation:**
  - In meetings, each viewer picks a "Translate to" language (licence-gated).
  - In town halls, the organiser preselects 6 caption languages (10 with Premium) and each attendee chooses one.
  - The Interpreter agent does per-listener speech to speech in up to 10 languages. A Balance slider mixes original
    and translated audio, and the voice is either "simulate my voice" or synthetic.
  - Interpreter is not in town halls or webinars, and recordings keep only the original audio.
- **AI:**
  - Joining more than 5 minutes late with Copilot on brings an offer to catch you up.
  - The organiser sets Copilot to work during and after the meeting, during only, or off.
  - After the meeting, the Recap tab offers chapters built from the transcript and PowerPoint Live, speaker and
    @mention markers, and personal join/leave markers on the timeline.
  - Video and audio recaps were added in 2026.
- **Rewind:**
  - Town halls let viewers seek back on a hover progress bar, and "Watch Live" returns them.
  - Reactions and hand raise work only while watching live.
- **Engagement:** town-hall Q&A with replies, reactions and optional moderation, reactions up to 3,000 attendees,
  and hand raise to bring someone on screen (not on iOS).
- **Accessibility:**
  - A personal sign-language mode with preferred signers.
  - CART captions.
  - Immersive Reader on posts and chat (Education).
- **Borrow:**
  - "Watch Live" snap-back.
  - Personal join/leave markers on the timeline.
  - The original/translated audio Balance slider.
  - Chapters that use slide content.
  - A personal sign-language mode.
- **Sources:**
  - Live captions and translation: https://support.microsoft.com/en-us/teams/meetings/use-live-captions-in-microsoft-teams-meetings
  - Town hall attendee: https://support.microsoft.com/en-us/teams/meetings/attend-a-town-hall-in-microsoft-teams
  - Live transcript: https://support.microsoft.com/en-us/office/view-live-transcription-in-microsoft-teams-meetings-dc1a8f23-2e20-4684-885e-2152e06a4a8b
  - Interpreter: https://support.microsoft.com/en-us/teams/copilot/interpreter-in-microsoft-teams-meetings-and-calls
  - Copilot catch-up: https://support.microsoft.com/en-us/teams/copilot/catch-up-on-meetings-with-microsoft-365-copilot-in-teams
  - Recap: https://support.microsoft.com/en-us/teams/meetings/recap-in-microsoft-teams
  - Video recap: https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/what%E2%80%99s-new-in-microsoft-365-copilot--may-2026/4522010
  - Sign-language mode: https://support.microsoft.com/en-us/accessibility/teams/use-sign-language-mode-in-microsoft-teams-meetings
  - Immersive Reader: https://support.microsoft.com/en-us/education/learning-accelerators/use-immersive-reader-in-microsoft-teams

#### Webex (with Slido and AI Assistant)

- **Layout:**
  - The captions and transcript panel sits on the right and shows the spoken language.
  - The sign-language interpreter's video pops out into its own window.
  - Webcast view in the browser has only play/stop, rejoin, volume, picture-in-picture and full screen.
- **Translation:**
  - Each participant picks a caption language (paid, 120+ languages).
  - Docs conflict on the cap of distinct languages per meeting (15 vs 5).
  - Human interpretation channels come with a 0–100 balance between original and interpreted audio; recordings keep
    only the original.
  - The AI Translator Agent (speech to speech) is announced for one-to-one calls only.
- **AI:**
  - In-meeting "Catch me up" summarises the last 15 minutes, with an option to expand to the whole meeting.
  - Auto-prompts appear when you join 12+ minutes late or step away for a minute or more.
  - Answers cite sources, are private, and are not saved.
  - Summary and transcript land in history after the meeting, with consent.
- **Rewind:** none in webcast view; recordings have ±10 s skip.
- **Engagement:** Slido Q&A with upvotes and moderation, polls in the Apps panel, full Slido up to 10,000 attendees,
  and a post-event activity report.
- **Accessibility:**
  - Tested with JAWS; F6 cycles between panels; shortcuts are customisable.
  - Screen readers cannot read shared content.
- **Borrow:**
  - A "you stepped away" catch-up prompt.
  - A fixed-window recap ("last 15 minutes").
  - Citations on AI answers.
- **Sources:**
  - Translation and transcription: https://help.webex.com/en-us/article/nqzpeei/show-real-time-translation-and-transcription-in-meetings-and-webinars
  - Language cap (conflicting): https://help.webex.com/en-us/article/7dzhht
  - Interpretation: https://help.webex.com/en-us/article/o0p0l4/Simultaneous-interpretation-in-Webex-meetings,-webinars-and-Personal-Rooms
  - Translator Agent: https://blog.webex.com/collaboration/translator-agent-brings-real-time-ai-translation-to-webex-calling/
  - AI Assistant: https://help.webex.com/article/nyzkuik/Webex-App-|-Cisco-AI-Assistant-in-meetings
  - Webcast view: https://help.webex.com/en-us/article/1s2o3h/Join-a-webinar-in-webcast-view
  - Accessibility: https://help.webex.com/en-us/article/84har3/Accessibility-features-for-meetings-and-webinars
  - Slido Q&A: https://help.webex.com/en-us/article/nsgzhsdb/Q&A-in-Slido
  - Slido limits: https://community.slido.com/slido-for-webex-90/how-many-participants-can-use-slido-in-webex-2442

#### Whereby

- **Captions and transcript:**
  - Live captions are a paid open-beta add-on for Whereby Embedded, switched on by an admin or per room.
  - The spoken language must be preset, and captions are not in the iOS app.
  - Session transcription downloads as Markdown at the end.
- **Engagement:** reactions, hand raise, chat, Miro whiteboard, breakout groups.
- **Accessibility:** claims WCAG 2.1 AA.
- **Not found:** translation, AI catch-up, rewind.
- **Borrow:** little for us beyond a clean, simple room.
- **Sources:**
  - Live captions: https://docs.whereby.com/whereby-product-features/live-captions
  - Session transcription: https://docs.whereby.com/whereby-product-features/transcribing/session-transcription
  - Features: https://whereby.com/information/features
  - WCAG claim: https://whereby.com/blog/designing-a-senior-friendly-telehealth-experience/

#### Jitsi Meet

- **Captions:** subtitles and transcription come through Jigasi and must be configured. They are not on the public
  meet.jit.si, and are paid on 8x8.
- **Engagement and tools:**
  - Polls (in a tab of the chat panel), breakout rooms, Excalidraw whiteboard, raise hand, shared Etherpad notes,
    talk-time statistics.
  - Rich single-key shortcuts, with "?" listing them.
- **Not found:** AI features, rewind, caption styling.
- **Borrow:** the keyboard shortcut set and its discoverable overlay.
- **Sources:**
  - Configuration: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-configuration/
  - Jigasi: https://github.com/jitsi/jigasi
  - Transcription on meet.jit.si: https://community.jitsi.org/t/transcription-and-caption-on-https-meet-jit-si/91164
  - Polls: https://developer.8x8.com/jaas/docs/23-september-2021-release
  - Features: https://jitsi.org/user-faq/
  - Shortcuts: https://jitsi.github.io/handbook/docs/user-guide/keyboard-shortcuts/

### Teaching platforms

#### BigBlueButton (3.0 / 4.0, open source)

- **Layout:**
  - 4.0 has a "media area" (slides, screen share, cameras, external video) with slide thumbnails.
  - Two side panels can be open together, and polls and analytics move into a pinnable apps gallery.
  - 3.0 had a layout centred on the presentation, plus Cameras Only, Presentation Only and Media Only modes.
- **Captions:**
  - Live transcription is a plugin (Gladia).
  - The language picked when joining audio drives the output, so translation follows the speaker, not the viewer.
  - Once anyone opts in, a CC button and a Transcript panel appear.
- **Recordings:** the player syncs slides, annotations, chat, captions and polls to the timeline. No search was
  found (snippet).
- **Engagement:** polls, quizzes with optional reveal, reactions, hand raise with a panel the moderator can lower
  hands from, breakout rooms, whiteboard, and shared rich-text notes.
- **Teacher:** a Learning Analytics Dashboard with an activity score and a timeline: slides on top, reactions and
  hands per student below. It works live and afterwards.
- **Accessibility:** targets WCAG AA with stated exceptions (shared notes, captions).
- **Not found:** live AI, rewind.
- **Borrow:**
  - The analytics timeline that aligns slides with student signals.
  - Layout presets.
  - The trap to avoid: translation language tied to the speaker rather than the viewer.
- **Sources:**
  - What's new in 4.0: https://bigbluebutton.com/docs/4.0/getting-started/whats-new-in-bigbluebutton-4-0
  - New in 3.0: https://docs.bigbluebutton.org/3.0/new-features
  - Translation language issue: https://github.com/bigbluebutton/bigbluebutton/issues/21229 (snippet)
  - Recording player: https://docs.bigbluebutton.org/development/recording/ (snippet)
  - Features: https://bigbluebutton.org/features/
  - Analytics dashboard: https://bigbluebutton.com/docs/help/moderator-guide/learning-analytics-dashboard
  - Accessibility: https://bigbluebutton.org/accessibility/

#### Class (class.com)

- **Layout:**
  - A "Front of Room" with the instructor on a podium (top left).
  - Sidebar tools that pop out into windows.
  - The teacher can open, close and lock tabs for everyone.
  - Seating charts sort students by longest-waiting raised hand or by speaking time.
- **Transcript:**
  - Live auto-transcription inside the session.
  - Students highlight, edit and save notes in the transcript.
  - Students switch between transcript, notes or both.
- **AI:** an assistant (beta) explains highlighted transcript text, answers questions about current and past
  sessions, and makes study guides.
- **Teacher:** a live engagement score refreshed every 30 s, and a dashboard with CSV export.
- **Accessibility:**
  - Captions are controlled by each learner.
  - A dedicated sign-language interpreter slot under the podium.
  - Claims WCAG 2.1.
- **Mobile:** web only; the mobile learner view is listed as "coming soon".
- **Not found:** translation, rewind.
- **Borrow:**
  - "Explain this" on highlighted transcript text.
  - Toggling between transcript and notes.
  - A fixed interpreter slot.
- **Sources:**
  - Interface: https://www.class.com/features/flexible-accessible-interface/
  - Transcript, AI and analytics: https://www.class.com/features/data-automation/
  - Assistant and mobile: https://class.com/?p=54093
  - Home page: https://www.class.com/

#### Engageli

- **Layout:**
  - Persistent virtual "tables" (small groups).
  - Room Mode, where everyone hears the class, versus Table Mode, where you hear only your table.
  - Raising a hand moves a student to the podium.
- **Captions:**
  - Enabled by the teacher or an admin; the student switches them on in Settings > Accessibility.
  - The spoken language is auto-detected.
  - Captions cover only podium or room audio, never table talk (snippet).
- **Live AI:**
  - A note-taker summarises the last 15 minutes for latecomers and writes timestamped notes into the student's
    notebook.
  - A chat recap of key topics and questions, and a synopsis per table.
  - AI drafts polls and quizzes from slides and discussion, which the teacher reviews first.
  - Related chat questions are grouped into one signal.
- **After class:** a summary by topic, a cleaned transcript, chapters, and quiz prompts in the Playback Room.
- **Translation:** only for the 30-second video summaries.
- **Accessibility:** a sign-language interpreter overlay.
- **Not found:** rewind.
- **Borrow:**
  - AI notes written into the student's own notebook.
  - Teacher review before AI polls go out.
  - Grouping duplicate questions.
- **Sources:**
  - AI classroom suite: https://www.engageli.com/features/ai-classroom-suite
  - AI overview: https://www.engageli.com/products-services/ai
  - AI for teachers blog (Aug 2026): https://www.engageli.com/blog/what-does-ai-for-teachers-actually-look-like-in-a-live-classroom
  - Room Mode: https://support.engageli.com/hc/en-us/articles/17981099733019-Understanding-Room-Mode (snippet)
  - Closed captions: https://support.engageli.com/hc/en-us/articles/46752030096923-Engageli-Closed-Captions-Guide (snippet)

### Lecture capture and video

#### Kaltura

- **Rewind:**
  - "Live DVR" lets viewers pause and rewind up to 2 h (24 h on request); off by default.
  - Town-hall webcasts resume where the viewer left off.
  - No DVR in lecture capture or virtual classroom (snippet).
- **Captions:**
  - REACH live machine captions, plus translated caption languages ordered in parallel, for scheduled webcasts only.
  - One page says live captions are English-only, which conflicts with the others (snippet).
- **Recordings:**
  - Machine dubbing adds a text-to-speech audio track in the player's audio menu.
  - Extended audio description is text spoken by the browser that pauses the video when needed.
  - The transcript plugin is searchable, click-to-seek and can pop out.
  - A dual-screen plugin syncs camera and slides, with slide-change cue points (snippet).
- **AI:**
  - Content Lab makes editable chapters and summaries after the fact.
  - A player plugin shows the current chapter on the timeline with expandable summaries.
  - Genie answers questions with clip "flashcards" and sources (snippet).
- **Engagement:** webcast polls (presenter controls when results show), Q&A with likes and replies, a feed with
  pinned messages and reactions.
- **Borrow:**
  - Extended audio description: the closest model for our slide-description track.
  - An audio selector that appears only when there is more than one track.
  - Clip-based AI answers.
- **Sources:**
  - Create a live stream: https://knowledge.kaltura.com/help/create-a-live-stream (snippet)
  - Webcasting: https://knowledge.kaltura.com/help/kwebcast (snippet)
  - Live solutions compared: https://knowledge.kaltura.com/help/what-are-the-differences-between-kalturas-live-stream-solutions (snippet)
  - Live captions: https://knowledge.kaltura.com/help/kaltura-webcasting-managing-live-captions (snippet)
  - Dubbing: https://knowledge.kaltura.com/help/order-dubbing (snippet)
  - Audio description: https://knowledge.kaltura.com/help/using-audio-descriptions-in-the-kaltura-player (snippet)
  - Transcript plugin: https://knowledge.kaltura.com/help/transcript (snippet)
  - Player plugins: https://knowledge.kaltura.com/help/player-plugins-and-functions (snippet)
  - Summary and chapters: https://knowledge.kaltura.com/help/create-a-summary-and-chapters-with-ai (snippet)
  - Genie: https://knowledge.kaltura.com/help/genie-user-guide (snippet)
  - Webcast polls: https://knowledge.kaltura.com/help/kaltura-webcasting-polls (snippet)

#### Panopto

- **Rewind:**
  - Viewers can rewind during a live broadcast.
  - A LIVE button returns to the live feed, about 40 s behind (snippet).
  - The full recording is on demand right after the stream.
- **Viewer layout:**
  - A left sidebar with tabs: Contents (slide titles taken from the slide text, with times), Captions (full
    transcript), Notes, Discussion, Bookmarks, Search.
  - Video and slides sit side by side (snippet).
- **Search:** spoken words and on-screen slide text (OCR) are indexed with timestamps.
- **Notes:** timestamped notes, private by default, which the viewer can make public if the teacher allows.
  Searchable bookmarks.
- **AI (Access AI add-on, recordings only):**
  - Chapters, "Key Points" summaries, and caption translation into up to 3 extra languages.
  - 2026 adds AI search, study guides, flashcards, quizzes and an AI tutor.
- **Live captions:** partial. RTMP captioning exists; a 2026 release note claims faster captions when streaming
  live (snippet).
- **Engagement:** live polls and Q&A only through integrations.
- **Borrow:**
  - Slide titles (read from the slide text) as a table of contents.
  - Search over both speech and slide text.
  - Private-by-default timestamped notes.
- **Sources:**
  - Mobile and rewind: https://www.panopto.com/features/mobile-video/
  - Live streaming: https://www.panopto.com/features/live-streaming/
  - AI capabilities: https://www.panopto.com/capabilities/ai-capabilities.md
  - Accessibility: https://www.panopto.com/capabilities/accessibility/ (snippet)
  - Embedded viewer: https://support.panopto.com/s/article/Learn-About-the-Features-of-the-Embedded-Video-Viewer (snippet)
  - Student tools: https://reed.edu/it/teaching-with-technology/panopto-tools-students.html (snippet)
  - Notes and bookmarks: https://blogs.sussex.ac.uk/tel/2019/11/29/focus-on-panopto-notes-and-bookmarks (snippet)
  - AI chapters and summaries: https://services.northwestern.edu/TDClient/30/Portal/KB/Article/2960/Panopto-Access-AI-AI-Chapters-and-AI-Summaries (snippet)
  - Caption translation: https://blogs.aalto.fi/opit/2025/09/26/new-in-panopto-accessible-and-multilingual-recordings-with-access-ai/
  - 2026 AI search: https://itbrief.co.uk/story/panopto-adds-ai-search-learning-tools-to-video-hub (snippet)

#### Echo360 (EchoVideo)

- **Live layout:**
  - A layout menu offers Featured, Picture-in-Picture, Split horizontal or vertical, and Grid.
  - A Sources button shows or hides the camera and slide feeds.
  - Mobile browsers show only one feed.
- **Rewind:** none. The live stream cannot be rewound, and an "Out Of Sync" button jumps back to real time.
- **Live captions:** the admin and teacher switch them on. The viewer toggles them and can reposition, resize and
  choose light or dark. Capped at 4 hours.
- **Signals and notes:**
  - Students flag a slide as confusing, anonymously, live or later; the teacher sees a count per slide and a list
    with jump links.
  - Timestamped bookmarks.
  - Live notes carry slide stamps.
  - The newer player lacks notes and flags (snippet).
- **Q&A:** a Discussions panel where a teaching assistant answers or forwards questions; posts reappear beside the
  recording.
- **AI (AskEcho, recordings only):** summaries, editable chapters on timeline hover, FAQs; rolled out per feature by
  the institution.
- **Teacher:** a "Total Engagement" metric (views, polls, Q&A, notes, confusion flags) with CSV export.
- **Borrow:**
  - Anonymous per-slide confusion flags.
  - Q&A that persists into the recording.
  - Show or hide each source.
- **Sources:**
  - Viewing live classes: https://support.echo360.com/hc/en-us/articles/11077111709581-EchoVideo-Viewing-Live-Streamed-Classes
  - Live captioning: https://support.echo360.com/hc/en-us/articles/41825286601229-EchoVideo-Turning-Live-Captioning-for-the-Institution-On-or-Off (snippet)
  - Flagging and bookmarking: https://support.echo360.com/hc/en-us/articles/11077695519885-EchoVideo-Flagging-and-Bookmarking-Content (snippet)
  - Legacy classroom tools: https://support.echo360.com/hc/en-us/articles/11077551674893-EchoVideo-Using-Legacy-Classroom-Tools (snippet)
  - AskEcho deployment notes: https://support.echo360.com/hc/en-us/articles/36855388581005-EchoVideo-2025-Deployment-Notes-29-30-May-CA-EU-and-US
  - AskEcho at Warwick: https://warwick.ac.uk/services/digitallearning/support/guides/echovideo-guides/askecho/
  - Analytics metrics: https://support.echo360.com/hc/en-us/articles/11077110560653-EchoVideo-Definitions-of-Course-Analytics-Metrics (snippet)

### Live streaming

#### YouTube Live

- **Rewind:**
  - With DVR on (the creator's choice), viewers can pause and rewind back to the start of the stream.
  - Limited on streams over 12 hours and on some devices.
  - The help page does not describe a jump-to-live control.
- **Captions:**
  - Live auto-captions are English only, need normal latency, and are switched on per stream.
  - The replay gets new captions made afterwards, so the live captions are thrown away.
- **AI:**
  - Automatic chapters on uploads (opt-out).
  - A live-chat summary to help latecomers has been in test since 2024 (3rd-party).
  - Multi-language audio and auto-dubbing (about 27 languages) on demand, not live.
  - "Ask YouTube" for live streams was promised in May 2026 for a later release.
- **Chat:** chat replay plays back in sync with the archived video.
- **Notable:** YouTube TV gives late joiners four choices: start, a point, live, or catch up to live through
  highlights (3rd-party).
- **Borrow:**
  - The late-joiner choice screen.
  - Chat replay synced to the timeline.
- **Sources:**
  - DVR: https://support.google.com/youtube/answer/9296823?hl=en
  - Live auto-captions: https://support.google.com/youtube/answer/6373554?hl=en
  - Automatic chapters: https://support.google.com/youtube/answer/9884579?hl=en
  - Multi-language audio: https://techcrunch.com/2025/09/10/youtubes-multi-language-audio-feature-for-dubbing-videos-rolls-out-to-all-creators/
  - Live-chat summary (3rd-party): https://www.neowin.net/news/youtube-is-testing-channel-qr-codes-and-ai-generated-live-chat-summaries
  - Chat replay: https://techcrunch.com/2018/02/26/youtube-live-gains-automatic-captions-chat-replay-and-more/
  - Ask YouTube: https://www.searchenginejournal.com/youtube-expands-ai-creation-tools-with-gemini-omni-and-conversational-search/
  - YouTube TV catch-up (3rd-party): https://androidauthority.com/youtube-tv-go-live-button-3515937

#### Twitch

- **Rewind:** announced in May 2025 (go back, then return to live) with a small test; rollout status unknown.
- **AI:** stream summaries for viewers joining mid-stream (announced May 2026), the closest thing to a running
  recap.
- **Recaps:** Stream Recaps (Oct 2026) are clip reels. Saying "Twitch Clip That" while live adds a clip, and the
  streamer curates them in a filmstrip editor.
- **Captions:** no native live captions; creators use an extension overlay.
- **Mobile:** Dual Format gives phones a vertical view.
- **Borrow:**
  - A mid-stream synopsis on join.
  - Voice-triggered clip marking (a teacher could say "bookmark this").
- **Sources:**
  - Rewind announcement: https://blog.twitch.tv/en/2025/05/31/ten-years-of-twitchcon-here-s-what-we-announced-in-rotterdam/
  - Summaries and Dual Format: https://blog.twitch.tv/en/2026/05/30/everything-we-announced-at-twitchcon-rotterdam-2026/
  - Stream Recaps: https://blog.twitch.tv/en/2026/10/20/stream-recaps/
  - Accessibility guide: https://www.twitch.tv/creatorcamp/de-de/connect-and-engage/making-your-twitch-channel-more-accessible/

#### Vimeo Live (added; the best rewind reference)

- **Rewind:**
  - DVR covers the last 4 h.
  - A "Skip to live" button appears at the top left when the viewer is behind.
  - The timeline shows a negative offset (e.g. -15:00).
  - Sped-up playback returns to 1x on reaching live.
  - A notice appears if the event ends while you are behind.
- **Transcript:** a drawer during the live event; clicking a line seeks.
- **Translation:**
  - Viewers pick a caption language in the player.
  - One broadcast serves all languages, and the archive keeps every translated track.
- **Borrow:** almost the whole rewind interaction, plus keeping the translated tracks in the archive.
- **Sources:**
  - DVR: https://help.vimeo.com/hc/en-us/articles/22951852246801-How-to-use-DVR-when-watching-a-live-event
  - Caption translations: https://vimeo.com/product/live-caption-translations
- **Related:** Cloudflare Stream's LIVE badge is grey when behind and red at the live edge, and clicking it jumps to
  live. https://developers.cloudflare.com/stream/stream-live/dvr-for-live/

### Webinars and studios

#### StreamYard (On-Air)

- **Captions:** no native live captions; it points to platform captions or Chrome Live Caption (snippet).
- **AI:** captions on short clips after recording, English only.
- **Engagement:** viewers watch and chat on StreamYard; hosts show comments on screen or bring a viewer on stage for
  Q&A.
- **Borrow:** a studio-style "comment on screen" for the teacher to answer a question visibly.
- **Sources:**
  - Captions: https://support.streamyard.com/hc/en-us/articles/360059631432-Does-StreamYard-have-Captions (snippet)
  - AI captions on clips: https://support.streamyard.com/hc/en-us/articles/23044087971092
  - Watching on StreamYard: https://support.streamyard.com/hc/en-us/articles/360043298792-Can-people-watch-on-StreamYard
  - Q&A sessions: https://streamyard.com/blog/how-to-stream-qa-sessions

#### Riverside

- **Live:** up to 1,000 viewers. Desktop viewers can request a "call-in" to appear on screen; phone viewers get no
  chat or call-in.
- **AI (after recording):**
  - Show Notes: summary, keywords, takeaways, and chapter titles with timestamps.
  - Magic Clips highlights.
- **Not found:** live AI for viewers.
- **Borrow:** the shape of the show notes (summary, takeaways, timestamped chapters) for our recap track.
- **Sources:**
  - Live audience: https://support.riverside.com/hc/en-us/articles/5287476520093
  - AI Show Notes: https://support.riverside.com/hc/en-us/articles/17531834479901-About-AI-Show-Notes
  - Show notes page: https://riverside.com/show-notes

#### Livestorm

- **Layout:** a browser room with a stage and a side panel with tabs for People, Polls, Questions and Chat
  (3rd-party guide).
- **Captions:** each attendee toggles them on their own toolbar, at the bottom of the stage. Not on pre-recorded
  video or RTMP input.
- **Translation:**
  - Text only, a paid add-on.
  - Each attendee picks one of 30 languages from the Captions menu.
  - About 10–15 s to the first caption and 5–10 s lag.
  - Changing language briefly reloads captions for everyone.
  - Nothing translated is kept in the replay.
- **Engagement:** hand raise; questions with upvotes and moderator statuses (reviews).
- **Interpretation:** human interpretation through Interprefy.
- **Borrow:**
  - Honest latency figures shown to users.
  - A per-attendee toggle on the toolbar.
- **Sources:**
  - Live captions: https://support.livestorm.co/article/live-captions
  - Live translation: https://support.livestorm.co/article/enable-live-translations
  - Features: https://livestorm.co/features
  - Interprefy: https://support.livestorm.co/article/256-interprefy
  - Attendee guide (3rd-party): https://www.airmic.com/sites/default/files/Attendee%20user%20guide%20Livestorm.pdf

### Live captions and translation

#### Wordly

- **Join and language:**
  - Attendees join by QR code or link, with no app or account.
  - They pick a language, then a session ID, and can change language any time from a dropdown.
- **Audio:** a speaker button plays synthetic speech of the translation after each sentence, so it lags the text.
  Same-language audio is opt-in.
- **Display modes:**
  - Normal (black on white), Display (white on black), High contrast (yellow on black).
  - Word by word, or complete phrases only.
- **Speaker labels:** the speaker's name starts each line, and ">>" marks a speaker change.
- **Limits:** attendees cannot download the transcript, and glossaries are set by the organiser only.
- **Borrow:**
  - The three contrast modes.
  - The complete-phrases option, which suits translated text.
  - QR join.
- **Sources:**
  - Attending a session: https://help.wordly.ai/attending-a-wordly-session
  - Attendee FAQ: https://www.wordly.ai/attendee-faq

#### Interprefy

- **Web widget:**
  - A headset icon picks the audio language ("None" means the original audio).
  - An eye icon picks the caption language, and "Aa" offers 3 text sizes.
  - Sign-language video can be chosen instead of captions.
- **Delivery:** the selector opens in a new window, a pop-up or embedded in the page.
- **Mobile:** the app takes a token and sets audio and caption languages separately.
- **AI and human:** human interpreters and the AI speech translator (Aivia) on one platform (press).
- **Borrow:**
  - Separate audio-language and caption-language choices.
  - Sign language as a selectable track.
- **Sources:**
  - Widget guide: https://ai-knowledge.interprefy.com/user-guide-for-interprefys-widget-on-third-party-platform.md
  - Mobile app: https://knowledge.interprefy.com/interprefy-mobile-app-user-guide
  - Separate window: https://knowledge.interprefy.com/how-does-interprefy-select-work-in-a-separate-browser-window
  - On-site captions: https://knowledge.interprefy.com/how-can-i-give-my-audience-a-choice-of-captions-languages-at-my-onsite-event
  - Aivia (press): https://www.bizbash.com/corporate-events/interprefy-launches-next-generation-ai-speech-translator-for-events

#### Otter.ai

- **Live transcript:**
  - Students follow on web or phone.
  - They highlight lines (collected as takeaways), filter by keyword, comment and add images.
  - Stored transcripts are searchable.
- **Slide capture:** new slides or screen shares are captured into the transcript automatically during virtual
  meetings, with a manual capture button.
- **Live summary:** a real-time summary was promised in 2024; the education page describes summaries after class.
- **Otter Chat:** questions about the meeting (3rd-party).
- **Borrow:**
  - Slide capture inline in the transcript.
  - Highlights collected into takeaways.
- **Sources:**
  - Education: https://otter.ai/education
  - Slide capture: https://help.otter.ai/hc/en-us/articles/5093321813911-Automated-Slide-Capture-Overview
  - 2024 launch: https://www.businesswire.com/news/home/20240213085080/en/Otter.ai-Takes-Aim-at-Goliath-with-New-Meeting-GenAI-Launch-Slingshots-Past-Microsoft-Copilot-to-Redefine-AI-Meeting-Intelligence

#### Microsoft Translator live / Azure Live Interpreter

- **Translator:** the multi-device conversation is still listed as Preview.
- **Successor tech:** the Azure Live Interpreter API (preview Sept 2025) does real-time speech to speech in the
  speaker's own voice, with automatic detection of many input languages. Personal voice needs Limited Access
  approval.
- **Borrow:** a reference for what a spoken Turkish track could sound like, and its consent gating.
- **Sources:**
  - Translator live: https://www.microsoft.com/en-us/translator/business/live/
  - Speech translation docs: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation
  - Live Interpreter coverage: https://tech.slator.com/microsoft-live-interpreter-api-ai-live-speech-translation/

#### Ava

- **Captions:** each speaker is colour-coded and labelled.
- **Display:** floating captions on desktop and a large-format display mode.
- **Other features:** translation into 20+ languages, an AI-plus-human scribe option, and Ava Voice (deaf users type
  and the app speaks).
- **Borrow:** speaker colours (useful when a student asks a question aloud), and the large-format mode for a room
  screen.
- **Sources:**
  - Live captions: https://ava.me/live-captions
  - Translation: https://ava.me/blog/ava-vs-live-transcribe-live-captions-for-every-situation
  - Ava Show: https://www.ava.me/blog/introducing-the-new-ava-android-app-faster-stronger-and-smarter-than-ever

### Engagement

#### Slido

- **Join:**
  - By code, link or QR, with no app or login.
  - The code is limited to the event dates, but the link never expires, so questions can be collected early.
- **Q&A:** anonymous by default, and upvotes push questions to the top.
- **AI (2.0, April 2026):**
  - Polls generated from the slides and placed at matching points.
  - Quizzes.
  - A "Question AI" helps a participant clarify a question before sending it.
- **Borrow:**
  - Anonymous upvoted Q&A.
  - Polls drafted from slides.
  - Question tidy-up before sending.
- **Sources:**
  - Running a Q&A: https://community.slido.com/running-your-q-a-216/run-a-q-a-session-404
  - Anonymity: https://community.slido.com/setting-up-a-slido-event-82/participant-privacy-set-anonymous-or-named-questions-and-poll-votes-by-default-1609
  - Slido AI 2.0: https://community.slido.com/product-news-announcements-108/slido-ai-2-0-work-smarter-than-ever-7896

#### Mentimeter

- **Join:** by code, QR (switchable per slide) or link.
- **Q&A:** on a dedicated slide or on every slide, with optional upvoting.
- **Pacing:** audience-paced or presenter-paced.
- **AI:** builds a session from a prompt, and groups open answers into themes.
- **Borrow:** Q&A open on every slide, and theme grouping.
- **Sources:**
  - Participating: https://help.mentimeter.com/en/articles/410537-how-to-participate-in-a-mentimeter-presentation
  - Audience Q&A: https://help.mentimeter.com/how-to-vote/questions-from-audience-the-audience-perspective
  - Features: https://www.mentimeter.com/features
  - Voting pace: https://www.mentimeter.com/blog/menti-news/live-presentation-or-survey-the-ultimate-guide-to-voting-pace

### Course players

#### Coursera

- **Transcript:**
  - Clicking a line seeks, on web and phone.
  - Highlighting a phrase and choosing "Save Note" makes a timestamped note, optionally with a frame screenshot
    (snippet).
- **Settings:** a gear menu for speed and subtitles; machine translations are marked "auto", and a flag reports
  translation errors.
- **Dubbing:** AI dubbing (April 2025) keeps the speaker's voice in several languages.
- **AI:** Coach in a sidebar summarises lectures and explains concepts.
- **Borrow:**
  - Highlight to note with a frame screenshot.
  - The "auto" label and a report-error flag on machine output.
- **Sources:**
  - Mobile transcripts and notes: https://blog.coursera.org/new-mobile-features-transcripts-notes-reminders/ (snippet)
  - Unified notes: https://blog.coursera.org/ready-for-retention-presenting-a-unified-note-taking-experience/ (snippet)
  - Video settings: https://www.coursera.support/s/article/209818653-Change-video-settings (snippet)
  - AI dubbing: https://blog.coursera.org/coursera-launches-ai-dubbed-courses-in-spanish-french-brazilian-portuguese-and-german/
  - Coach: https://blog.coursera.org/coursera-coach-leveraging-genai-to-empower-learners/ (snippet)

#### edX / Open edX

- **Player:**
  - "Show transcript" opens a scrolling transcript beside the video; clicking a line seeks.
  - The caption overlay can be dragged.
  - One language menu sets captions and transcript together.
  - Arrow keys scrub, and the transcript downloads as .srt or .txt.
- **AI:**
  - Xpert translations: machine-translated transcripts, where the chosen language persists across the course.
  - "Summarize" at the end of a unit, with an info icon explaining how the summary was made.
- **Borrow:**
  - A language choice that persists across lectures.
  - Explaining how an AI summary was made.
- **Sources:**
  - Video player: https://docs.openedx.org/en/ulmo/learners/SFD_video_player.html
  - Xpert translations: https://edx.readthedocs.io/projects/edx-partner-course-staff/en/stable/course_features/xpert_translations/feature_description.html
  - Xpert summaries: https://edx-partner-course-staff.readthedocs.io/en/latest/course_features/xpert_summaries/summaries_overview.html (snippet)

## 3. Pattern catalogue

Sources for every product named here are in its card above.

### Viewer layout

- **Stage plus side panel with tabs.** The dominant shape: Livestorm (People, Polls, Questions, Chat), Panopto
  (Contents, Captions, Notes, Bookmarks, Search), Teams and Zoom (panels on the right), BigBlueButton 4.0 (two
  panels side by side).
  - Works well when tabs are few and stable.
  - Gets cluttered when every feature adds a tab.
- **Content beside the speaker with a resizable split.** Zoom side by side, Echo360 layout menu, Kaltura
  dual-screen. Echo360's show/hide per source is the cleanest.
- **Pop-out panels.** Zoom captions, Class tools, Webex interpreter window, Interprefy selector, Teams Copilot.
  Useful on a second monitor.
- **Teacher on a fixed "podium".** Class and Engageli. Makes the single-speaker case explicit, which fits Talk
  Tracks.
- **Assessment:** nobody has a layout built around one speaker plus slides plus switchable text layers. Meeting
  tools assume many faces; capture tools assume playback.

### Caption and transcript UI

- **Caption strip at the bottom of the stage, toggled per viewer.** Universal (Zoom, Meet, Teams, Livestorm,
  Echo360, Engageli).
- **Live transcript panel:**
  - Zoom: searchable and saveable.
  - Teams: desktop only, no search.
  - Vimeo: drawer, click-to-seek live.
  - BigBlueButton: panel after opt-in.
  - Class: highlight and notes inline.
- **On-demand interactive transcript (click to seek, search, highlight to note).** Kaltura, Panopto, edX, Coursera
  do it well. edX keeps the language choice across a course.
- **Caption persistence:**
  - Weak: YouTube regenerates replay captions, Teams does not save captions, Zoom stopped caption saving in 2026,
    Livestorm keeps no translations.
  - Vimeo keeps every translated track: the best case.
- **Speaker attribution:** names (Zoom, Teams), colours (Ava), ">>" on speaker change (Wordly).
- **Assessment:** the best live transcript today is Vimeo's (click-to-seek during the live event). Nobody shows the
  original and translated transcript side by side live, though Zoom shows both caption lines.

### Translation UX

- **Viewer picks the caption language.** Zoom, Meet, Teams, Webex, Livestorm, Vimeo, Wordly, Interprefy, Kaltura.
- **Host whitelists the languages in broadcast modes.** Zoom pairs, Teams town hall 6 or 10, Kaltura parallel
  orders.
- **Spoken translation is opt-in per listener:**
  - Teams Interpreter (Balance slider, simulated or synthetic voice).
  - Meet speech translation (speaker consent, visible badge).
  - Wordly (synthetic voice after each sentence).
  - Interprefy, Webex and Zoom (human interpreter channels, Webex 0–100 balance).
  - None of them in large broadcasts (Teams excludes town halls and webinars; Meet excludes live streams).
- **Latency stated openly.** Livestorm 10–15 s to the first caption, Meet "a few seconds", Wordly audio after the
  sentence.
- **Pitfalls seen:**
  - BigBlueButton ties the translation language to the speaker.
  - Livestorm reloads everyone's captions when one person changes language.
  - Licence gates hide the feature (Teams, Webex).
- **Assessment:** text translation per viewer is solved. Separate audio and caption language choices (Interprefy)
  and a mix slider (Teams, Webex) are the mature audio patterns.

### AI recap, chapters and catch-up

- **Live, private, on demand:**
  - Zoom "Catch me up", scoped to "since you joined" or the whole meeting.
  - Meet "Summary so far" and Ask Gemini.
  - Webex last 15 minutes, with prompts on late join or stepping away.
  - Teams offer after 5 minutes late.
  - Engageli last 15 minutes plus notes written into the notebook.
  - Twitch mid-stream summary.
- **After the session:** Zoom smart chapters (editable), Teams Recap (chapters, @mention and join/leave markers),
  Kaltura chapters plugin, Panopto Key Points, Echo360 AskEcho, Riverside show notes, YouTube auto chapters,
  edX unit summaries.
- **Grounding and trust:** Webex cites sources; Meet notes cite transcript times; edX explains how a summary was
  made; Coursera labels "auto" output and offers a flag to report errors.
- **Assessment:**
  - Catch-up depends on the AI having run before the viewer arrived, so an always-on recap is the fix.
  - Chapters never grow live.
  - No product offers a glossary.

### Catch-up and rewind

- **DVR with a return-to-live control:**
  - Vimeo: best documented ("Skip to live", -mm:ss offset, speed returns to 1x at live, notice if the event ends).
  - Teams town hall: "Watch Live".
  - Panopto: LIVE button.
  - Kaltura: 2 h, resume.
  - YouTube: DVR, no documented jump-to-live.
  - Cloudflare Stream: grey or red LIVE badge.
- **No rewind:** Echo360 (an "Out Of Sync" jump instead), Webex webcast, Zoom webinars, Meet live streams,
  Livestorm; Twitch is still testing.
- **Late-joiner choice:** YouTube TV offers start, a point, live, or catch up through highlights.
- **Assessment:**
  - Rewind and AI catch-up are never combined.
  - Side tracks (captions, slides, transcript) are not documented to follow the rewound position, except Vimeo's
    transcript.
  - Teams turns reactions off while you are behind live, a detail worth copying.

### Engagement

- **Q&A:** anonymous with upvotes is the norm (Slido, Zoom, Livestorm, Kaltura likes, Mentimeter).
  - Moderation queues: Slido, Teams town hall.
  - A teaching assistant answers or forwards: Echo360.
- **Polls and quizzes:** everywhere. AI drafts them from slides with teacher review (Slido 2.0, Engageli).
- **Hand raise:** with a queue sorted by wait time (Class), a moderator lower-hand panel (BigBlueButton), or
  bringing the viewer on stage (Teams, Riverside, StreamYard).
- **Reactions:** universal. Zoom lets a viewer hide them; Teams disables them while you are behind live.
- **Confusion signals:** Echo360's anonymous per-slide flag is the only one, and the newer player dropped it.
- **Grouping:** Engageli groups related chat questions; Mentimeter groups open answers into themes.
- **Assessment:** the pieces are mature; the gaps are slide-anchored signals and AI de-duplication for the teacher.

### Notes and bookmarks

- **Timestamped notes:** Panopto (private by default, shareable), Coursera (highlight transcript, save note,
  screenshot), Engageli (AI writes into the notebook), Class (notes inside the transcript), Otter (highlights into
  takeaways).
- **Bookmarks:** Panopto (searchable tab), Echo360 (live bookmark button). Echo360's live notes are slide-stamped.
- **Meetings:** almost nothing personal (Zoom My Notes only).
- **Assessment:** no product anchors a note to both time and slide, and live bookmarks are rare.

### Teacher console

- **Caption and AI governance:**
  - Zoom approves caption requests and scopes AI questions.
  - Teams sets Copilot to work during and after, during only, or off.
  - Webex saves both summary and transcript, the summary only, or neither, with consent.
  - Meet requires explicit consent.
- **Live analytics:**
  - BigBlueButton dashboard (slides timeline against reactions and hands).
  - Class engagement score every 30 s.
  - Engageli per-table metrics.
  - Echo360 Total Engagement.
- **Layout control:** Zoom forces attendee views; Class locks tabs for everyone.
- **Assessment:** no console shows which AI layers are in use, by how many people, and what they cost. Talk Tracks'
  lazy, subscription-driven agents make that both possible and useful.

### Accessibility

- **Caption styling per viewer:**
  - Zoom, Meet (saved per user), Teams (persisted), Echo360 (light/dark, size, position).
  - Wordly's three contrast modes and complete-phrase mode.
  - Interprefy's three sizes.
- **Sign language:**
  - Video channels the viewer chooses: Zoom (up to 20, pinned), Teams personal mode with preferred signers, Webex
    pop-out, Class fixed slot, Engageli overlay.
  - Interprefy makes sign language an alternative to captions.
- **Screen readers:**
  - Meet and Webex test with JAWS and NVDA, and Webex adds F6 panel cycling.
  - Webex states that shared content cannot be read by screen readers.
- **Audio description:** only Kaltura (recordings), with extended descriptions spoken by browser text-to-speech that
  pause playback.
- **Keyboard:** Jitsi's single-key shortcuts with a "?" overlay.
- **Assessment:** no product describes slides or shared content live. That is Talk Tracks' clearest accessibility
  gap to fill.

### Mobile

- **Documented limits:**
  - Zoom: no side-by-side on phones; AI questions desktop only.
  - Teams: live transcript desktop only; town halls need the app.
  - Echo360: one feed on mobile browsers.
  - Class: mobile "coming soon".
  - Riverside: no chat or call-in on the phone app.
  - Whereby: no captions on iOS.
- **Good patterns:**
  - Phone as a second screen joined by QR (Wordly, Slido, Mentimeter, Interprefy on-site captions).
  - Twitch's vertical Dual Format.
- **Assessment:** browser-first, phone-equal design is a real differentiator; almost every incumbent treats mobile
  as a reduced mode.

## 4. Capability matrix

Values:

- **yes**: documented and usable.
- **partial**: limited, gated, recording-only where live is meant, or announced but not shipped.
- **no**: not found in public docs.
- **?**: not checked.
- **–**: not applicable (on-demand product).

"Live" means during the session. Each cell summarises the product card above.

**Captions, translation and AI**

| Product | Live captions | Viewer picks caption language | Spoken translation | Live transcript panel | Transcript click-to-seek or search | Live AI catch-up | Chapters or summary after | Live chapters |
|---|---|---|---|---|---|---|---|---|
| Zoom | yes | yes | partial (human only) | yes | partial (search live; seek in recording) | yes | yes | no |
| Google Meet | yes | yes | yes (not live streams) | partial (scroll-back) | no | yes | yes | no |
| Microsoft Teams | yes | yes | yes (not town halls) | yes (desktop) | partial (recap markers) | yes | yes | no |
| Webex | yes | yes | partial (human; AI 1:1 only) | yes | ? | yes | yes | no |
| Whereby | partial (beta add-on) | no | no | no | no | no | partial (beta) | no |
| Jitsi Meet | partial (self-host config) | partial (moderator) | no | no | no | no | no | no |
| BigBlueButton | yes (plugin) | partial (speaker-tied) | no | yes | no | no | no | no |
| Class | yes | no | no | yes | ? | partial (assistant, beta) | partial (study guides) | no |
| Engageli | yes | no | no | ? | ? | yes (last 15 min) | yes | no |
| Kaltura | yes (webcasts) | yes | partial (TTS dub, recordings) | partial (on demand) | yes (on demand) | no | yes | no |
| Panopto | partial | partial (recordings) | no | partial (on demand) | yes (speech and slide text) | no | yes | no |
| Echo360 | yes | ? | no | ? | ? | no | yes | no |
| YouTube Live | partial (English only) | no | partial (dub, on demand) | no | ? | partial (chat summary test) | yes (auto chapters) | no |
| Twitch | partial (extension) | no | no | no | no | partial (announced) | partial (clip recaps) | no |
| Vimeo Live | yes | yes | no | yes | yes (live) | no | ? | no |
| StreamYard | no | no | no | no | no | no | partial (clips) | no |
| Riverside | no | no | no | no | no | no | yes (show notes) | no |
| Livestorm | yes | yes (add-on) | partial (human via Interprefy) | no | partial (replay, beta) | no | ? | no |
| Wordly | yes | yes | yes (synthetic voice) | partial (scrolling text) | no | no | ? | no |
| Interprefy | yes | yes | yes (human and AI) | no | no | no | ? | no |
| Otter.ai | yes | ? | no | yes | yes | partial (Otter Chat) | yes | no |
| MS Translator / Azure | yes | yes | yes (own voice, API) | partial | no | no | no | no |
| Ava | yes | yes | no | yes | ? | no | ? | no |
| Slido | – | – | – | – | – | – | – | – |
| Mentimeter | – | – | – | – | – | – | – | – |
| Coursera | – | yes (subtitles) | yes (AI dub, on demand) | – | yes | – | yes (Coach) | – |
| edX | – | yes (persists) | no | – | yes | – | yes (unit summary) | – |

**Rewind, engagement, notes and accessibility**

| Product | Live rewind and back to live | Q&A | Polls | Hand raise | Reactions | Personal notes or bookmarks | Caption styling | Sign-language view | Slide-aware features |
|---|---|---|---|---|---|---|---|---|---|
| Zoom | no | yes (upvotes) | yes | yes | yes | partial (My Notes) | yes | yes | no |
| Google Meet | no | yes | yes | yes | yes | partial (shared notes Doc) | yes | partial (pin) | no |
| Microsoft Teams | yes (town halls) | yes | ? | yes | yes | partial (timeline markers) | yes | yes | partial (Recap uses PowerPoint Live) |
| Webex | no | yes (Slido) | yes | ? | ? | no | ? | yes (pop-out) | no |
| Whereby | no | no | no | yes | yes | no | no | no | no |
| Jitsi Meet | no | no | yes | yes | yes | partial (shared pad) | no | no | no |
| BigBlueButton | no | no | yes | yes | yes | partial (shared notes) | ? | no | partial (analytics timeline) |
| Class | no | ? | yes | yes | yes | yes (in transcript) | ? | yes | no |
| Engageli | no | partial (grouped chat questions) | yes (AI-drafted) | yes | yes | yes (AI notes) | ? | yes | partial (polls from slides) |
| Kaltura | yes (DVR 2 h) | yes (likes) | yes | ? | yes | no | ? | ? | partial (slide cue points) |
| Panopto | yes | partial (integrations) | partial (integrations) | no | no | yes (timestamped notes, bookmarks) | ? | ? | yes (slide-text search, slide titles) |
| Echo360 | no ("Out Of Sync" only) | yes | yes | no | no | yes (bookmarks, notes) | partial | no | partial (per-slide confusion flags) |
| YouTube Live | yes (DVR) | ? | ? | no | ? | no | ? | no | no |
| Twitch | partial (testing) | no | ? | no | ? | partial (voice clips) | no | no | no |
| Vimeo Live | yes (best UX) | ? | ? | no | ? | no | ? | no | no |
| StreamYard | no | partial (on stage) | ? | no | ? | no | no | no | no |
| Riverside | no | partial (call-in) | ? | no | ? | no | no | no | no |
| Livestorm | no | yes (upvotes) | yes | yes | ? | no | ? | no | no |
| Wordly | no | no | no | no | no | no | yes (3 modes) | no | no |
| Interprefy | no | no | no | no | no | no | partial (3 sizes) | yes | no |
| Otter.ai | – | no | no | no | no | yes (highlights) | ? | no | yes (slide capture) |
| MS Translator / Azure | – | no | no | no | no | no | ? | no | no |
| Ava | – | no | no | no | no | no | partial (speaker colours) | no | no |
| Slido | – | yes (upvotes, AI tidy-up) | yes (AI from slides) | no | ? | no | – | – | yes (polls from slides) |
| Mentimeter | – | yes | yes | no | ? | no | – | – | partial (Q&A on every slide) |
| Coursera | – | – | – | – | – | yes (highlight to note) | ? | no | no |
| edX | – | – | – | – | – | ? | partial (draggable) | no | no |

## 5. Opportunities for Talk Tracks' twist

Where per-viewer opt-in tracks, live rewind, slide descriptions and several independent AI agents beat what exists.
Sizes are rough: **S** is about a day, **M** a few days, **L** a week or more for one lane.

1. **One tracks panel (O1).** A single per-viewer drawer listing every layer: captions, Turkish, slide
   descriptions, chapters, glossary, recap. Each has a switch, a live status ("starting", "about 4 s behind") and a
   one-line explanation.
   - **Why:** every incumbent scatters these across a CC button, a gear menu, an apps panel and an audio menu, and
     none treats AI output as layers you compose. This is the visible form of our architecture, and it makes lazy
     spend honest: tracks start when someone switches them on. Mobile uses the same panel as a bottom sheet.
   - **Size:** S–M.

2. **Rewind with every track in sync, and "Go live" (O2).**
   - **What:**
     - Scrubbing back moves the slide, captions, translation, transcript position and slide description together.
     - A "Go live" pill shows the offset (-04:30) and a LIVE badge that is grey when behind and red at the edge.
     - Optional 1.25x/1.5x catch-up returns to 1x at live.
     - Reactions and hand raise are muted while you are behind (as in Teams).
   - **Why:** Vimeo, Teams town halls, Panopto and Kaltura rewind only the media; none documents side tracks
     following the playhead.
   - **Size:** M–L.

3. **"What you missed" on returning to live (O3).** On "Go live", on a late join, or after the tab was hidden for
   a few minutes, offer a short recap of exactly the stretch you skipped, from the recap track, with "watch it
   instead" as the alternative (YouTube TV's choice screen).
   - **Why:** catch-up (Zoom, Meet, Webex, Teams, Engageli) and DVR exist, but never together. Webex's step-away
     prompt and Zoom's "since you joined" scope show demand for gap-scoped recaps.
   - **Size:** M.

4. **Live chapters anchored to slides (O4).** Chapters appear as the talk moves on, each with a slide thumbnail and
   a one-line title, as marks on the rewind timeline. Clicking one rewinds there.
   - **Why:** chapters are post-session everywhere (Zoom, Teams Recap, Kaltura, Panopto, Echo360, Riverside,
     YouTube). Panopto shows that slide titles make a strong table of contents.
   - **Size:** M.

5. **Slide descriptions for blind and low-vision students (O5).** On each slide change, a description is announced
   politely to screen readers, with an optional spoken version (browser text-to-speech) and a "describe in more
   detail" expansion. Descriptions are kept in the transcript stream so they can be rewound.
   - **Why:** no product describes slides or shared content live; Webex states screen readers cannot read shared
     content. Kaltura's extended audio description (recordings only) is the closest model.
   - **Size:** M.

6. **Live glossary (O6).** Terms are pulled out as the teacher introduces them. Tapping an underlined word in the
   captions or transcript opens a definition (and its Turkish equivalent) with a "first mentioned at 12:40" jump.
   - **Why:** no product has a glossary. Class's "explain highlighted text" is the closest, and it is a beta
     assistant rather than a track.
   - **Size:** M.

7. **Live interactive transcript, in two languages (O7).**
   - **What:**
     - Follows live with auto-scroll and a "jump to latest" chip.
     - Searchable, with click-to-seek (rewinds).
     - Optional original and Turkish shown side by side or interleaved.
     - Speaker colours for student questions (Ava).
   - **Why:** click-to-seek search is standard on demand (Kaltura, edX, Coursera) but rare live (Vimeo only), and
     nobody pairs the two languages.
   - **Size:** M.

8. **Notes and bookmarks anchored to time and slide (O8).**
   - **What:**
     - One-key bookmark (B).
     - Highlight a transcript line to make a note.
     - Each note carries the timestamp and the slide.
     - Export to Markdown.
     - Optionally, the recap track drops chapter summaries into your notes (Engageli).
   - **Why:** Panopto and Coursera stamp time and Echo360 stamps slides, but nobody stamps both, and live bookmarks
     are rare.
   - **Size:** S–M.

9. **"I'm lost here" per slide, and grouped questions (O9).** An anonymous one-tap signal tied to the current
   slide, and anonymous upvoted Q&A. An agent clusters duplicate questions for the teacher.
   - **Why:** Echo360's confusion flag is the only per-slide signal, and its newer player dropped it. AI grouping
     exists only in Engageli and Mentimeter. Upvoted anonymous Q&A is the expected baseline (Slido, Zoom,
     Livestorm).
   - **Size:** M.

10. **Teacher console with a track meter (O10).**
    - **What:**
      - Live slide controls.
      - Which tracks are on and for how many viewers.
      - Running spend against the ceiling.
      - The confusion heat per slide and the grouped question queue.
      - A "say it again" hint when many viewers rewind the same moment.
    - **Why:** no console shows AI layer usage or cost. Talk Tracks' lazy subscriptions make it real data.
      BigBlueButton's slide timeline is the best visual precedent.
    - **Size:** M.

11. **Caption display modes (O11).**
    - **What:**
      - Normal, dark and high-contrast (yellow on black) themes.
      - Size steps.
      - Word-by-word or complete phrases (better for translated text).
      - Position.
      - Remembered per viewer.
    - **Why:** Wordly, Interprefy, Meet and Echo360 each do part of this; together they are table stakes for
      accessibility.
    - **Size:** S.

12. **Phone as a second screen, and a real mobile layout (O12).** A QR code on the teacher's console or first slide
    opens the viewer on a phone.
    - **What:**
      - Slide on top.
      - Tracks as swipeable tabs (captions, transcript, glossary, chapters).
      - The tracks panel as a bottom sheet.
      - The same features as desktop.
    - **Why:** QR join is standard for engagement and captions (Wordly, Slido, Mentimeter, Interprefy), but
      incumbents treat mobile as a reduced mode (Zoom, Teams, Echo360, Class, Riverside).
    - **Size:** S–M.

13. **Ask the lecture (O13).** A private, opt-in question box grounded in the transcript and slides so far. Answers
    cite timestamps that rewind when clicked, and the teacher can switch it off.
    - **Why:** Zoom, Meet and Webex offer private grounded questions in meetings; Webex cites sources. Here it is
      just another lazy track that costs nothing until used.
    - **Size:** M.

14. **Tracks kept with the recording (O14).** When a talk ends, its live tracks (captions, translation,
    descriptions, chapters, glossary) stay attached for replay and the looped demo lectures. A later pass can tidy
    them without discarding the originals.
    - **Why:** YouTube regenerates replay captions, Teams does not save captions, Zoom stopped caption saving, and
      Livestorm keeps no translations. Only Vimeo keeps translated tracks.
    - **Size:** S–M.

15. **Spoken Turkish track with an audio mix slider (O15).** An opt-in synthetic Turkish voice, with a slider
    between the teacher's voice and the translation (Teams and Webex balance), and the expected delay shown.
    - **Why:** no product offers AI spoken translation in a one-to-many broadcast: Teams Interpreter excludes town
      halls and Meet excludes live streams. This is the costliest track, so it should be lazy.
    - **Size:** L.

## Gaps in this research

- Kaltura and Panopto help pages mostly would not load, so their details rest on search snippets.
- Mobile layouts are rarely documented by any vendor.
- Twitch chat and poll details were not covered.
- Teams poll mechanics and Webex reactions were not checked.
- Livestorm's AI summaries rest only on third-party claims.
- No product was opened in a browser, by design (public pages only), so layout descriptions come from docs rather
  than direct observation.
