# 07 · Submission

**Status:** in progress (rules, README, NOTICE, text, video script drafted) · **Session:** submission lane · **Window:** Tue Nov 3, 09:00 → Wed Nov 4, 12:00 ET (20:00 +03) ·
**Depends on:** 06 (product verified), 02 (banner, title cards)

## Goal

Submit a strong entry early: a short demo video, clear submission text, an up-to-date README, correct credits and
licences, and a frozen `main` that matches what judges will see.

## The rules (checked 2026-11-02)

Sources, in order of authority:

1. **Official Rules**, the contract every participant accepted. Published as the text of the Cerebral Valley event
   page and its waiver: [cerebralvalley.ai/e/meta-ai-developer-hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
   and [/waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver). Read from the page source on
   2026-11-02.
2. **Meta's event page**, [dev.meta.ai/events/global-hackathon](https://dev.meta.ai/events/global-hackathon): dates,
   tracks, themes, models. Agrees with 1.
3. **The participant rules sent to accepted participants on Oct 26** (email or Discord; not on a public page). Not
   seen by this lane; quoted verbatim by another entrant in
   [brianlee0113/firsthand `docs/HACKATHON_RULES.md`](https://github.com/brianlee0113/firsthand/blob/main/docs/HACKATHON_RULES.md).
   **The owner should check them against his own copy.**
4. **The submission form**, [cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit),
   behind the Cerebral Valley sign-in. Its fields were not visible to this lane; another entrant read them from the
   page's data ([ta-amps/ta-amps-hackathon `hackathon/event/11-submission.md`](https://github.com/ta-amps/ta-amps-hackathon/blob/main/hackathon/event/11-submission.md)).
   **The owner should sign in and look at the form before Tue evening.**

| Topic | Rule | Source | What it means for us |
|---|---|---|---|
| Deadline | "Project submissions due by 9:00 PM ET", Wed Nov 4. Judging Nov 4–8, winners Nov 9. | 1, 2 | 9 PM EST (UTC−5, clocks changed Nov 1) = **Thu Nov 5, 05:00 +03**. Our target stays 12:00 ET = **Wed 20:00 +03**. |
| Late changes | "Changing the repository after the deadline will mark this project late." Late projects are marked; hosts "may consider that during judging". | 4 (platform data, via the entrant) | Freeze `main` and push nothing to the repo after submitting. Work after that goes to a branch only if the owner says so. |
| Where | Cerebral Valley's portal (link above). | 1 | The owner submits; lanes never sign in. |
| Required fields | Reported: **GitHub Repository, Live Project, Demo Video, Project Description**; "every team member added". | 3, 4 | `wiki/submission.md` gives a paste-ready block per field. |
| Demo video | **3 minutes**, required, "one of the main things judges score". Judged under Demo (25 %): "the quality of the demo video". Host not stated. | 3, 1 | `wiki/submission-video.md` runs 2:55. Upload to YouTube (unlisted or public); test the link logged out. |
| New work | "Everything you present has to be built during the hackathon, Oct 26 to Nov 4." "Your demo has to show only the features, code and functionality your team built during the event. Judges need to be able to tell what's new." | 3 | First commit 2026-10-27; README "Built during the hackathon" says what is ours and what is third-party (moq-relay, Media Chrome, the lectures). The video says it once too. |
| Public repo | "Your submitted repository must be public." | 3 | github.com/LeventAksakal/talk-tracks is public. |
| Open source | Allowed "provided applicable open source licenses are followed and the Submission enhances or builds upon the underlying open source product." | 1 | `NOTICE` lists every third-party licence. |
| Our licence | None required. The entrant keeps ownership and grants the organisers "a perpetual, irrevocable, worldwide, royalty-free, and non-exclusive license" to the Submission. Submission must be "original work product" that does not violate others' IP. | 1 | Apache-2.0 stays. The demo lectures are CC BY-SA 4.0 and credited. |
| Meta models | "Participants build with Meta AI products, including Muse Spark, Glimmer, SAM 3, and any other Meta AI products identified on the Event page." Judged under **Use of Meta AI Tooling (25 %)**: "how creatively the team used Meta's AI tooling, whether they went beyond a basic integration, and whether they surfaced unexpected capabilities". | 1, 2 | We use Muse Voice Transcribe and Muse Spark (text and vision); the submission says what each does and what was unexpected. |
| Meta marks | No rule found on Meta logos or marks. | 1, 2 | Keep the brand lane's rule: no Meta logos in our assets or video. Name the models in words only. |
| Images | **No image sizes or cover image stated** anywhere public; the reported form fields have no image. | 1–4 | Nothing to make unless the form asks. Ready if it does: `web/public/og.png` (1200×630) and the video title card (1920×1080). |
| Tracks | Two tracks; one per project. Indie: individuals, students, teams up to 4, judged on "creativity, technical ambition, and whether it works". Startup: founders, "whether it holds up in production". | 1, 2 | Indie (solo). **Owner to confirm the track he applied for.** |
| Themes | Must fit one of two problem statements: "Build for Your World" (bring Meta's models into a domain you know and solve a real problem in it) or "Push the Frontier" (hard problems in software, robotics, manufacturing, energy or science). Impact is scored partly on "whether it fits one of the problem statements". | 1, 3 | Recommended: **Build for Your World** (live talks for people who cannot hear, see the slides, follow the language or arrive on time). **Owner to confirm.** |
| Banned projects | Disqualified for breaking law or policy or using material without rights; also "avoid the generic stuff" including "'AI for education' chatbots", "Basic RAG apps", "Simple image analyzers". | 3 | Talk Tracks is not a chatbot. The text frames it as live-media infrastructure and accessibility for any talk, not as an education chatbot, and never leads with "AI for education". |
| Judging weights | **Impact 30 %, Use of Meta AI Tooling 25 %, Technical Depth & Execution 20 %, Demo 25 %** ("a working, impressive demo, whether the product holds up live, and the quality of the demo video"). | 1 | The live site must hold up for judges Nov 4–8: demo rooms on, access code working, spend room left. |
| Team | One Representative submits and lists every member. | 1 | Solo: Levent Aksakal. |

## Checklist

- [x] **Re-read the hackathon rules** for video length, required fields, image sizes, and use of Meta models and
      marks. Note them here before anything else. (2026-11-02, table above; the owner still checks sources 3 and 4.)
- [ ] **Demo video** (script: [submission-video.md](../submission-video.md); the owner records) along the beats in submission-video.md, with the title and end cards from 02.
      Show the four demo moments ([howto/demo-moments.md](../howto/demo-moments.md)), Muse models at work, and the
      drawing replaying in rewind.
- [x] **Submission text** (draft in [submission.md](../submission.md), owner fills track, theme, video link, access code): problem, what it does, how it is built (MoQ, one publisher per agent, the track model),
      the Meta models used (README table), what was built during the hackathon, how judges try it (link plus access
      code or token).
- [x] **README** (lane/submission; screenshots still placeholders under `docs/screenshots/`): status line, the live link (if the owner allows the hostname in the public repo), screenshots,
      run-locally steps, credits.
- [x] **NOTICE** (from the lockfiles and Dockerfiles): every third-party licence, including anything new from 02 (fonts, icons) and 04
      (`perfect-freehand`, Excalidraw code if copied).
- [x] **Demo lecture credits** still match the rooms (README table).
- [ ] **Freeze `main`** Tue 18:00 +03: tag it (for example `submission-2026-11-04`) and deploy exactly that tag.
- [ ] Final smoke on the VM after the freeze: the four rooms loop, a judge link works, the spend ledger has room.
- [ ] **Submit by Wed 12:00 ET.** Save a copy of the submitted text in `wiki/submission.md`.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
| 11-02 23:30 | submission lane | Rules read from the Official Rules on the event page, Meta's page, an entrant's verbatim copy of the participant rules and an entrant's read of the form; table above. README rewritten (live link, try-it table, Mermaid architecture, models table, run locally, built-during), NOTICE written from the lockfiles, submission text and video script drafted. Open for the owner: track and theme, the form's real fields, the participant rules in his own copy. |
