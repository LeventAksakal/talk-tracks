# Changelog

All notable changes to the Talk Tracks project will be documented in this file.

The project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and targets the Meta Global AI Developer Hackathon (deadline: Wed Nov 4, 12:00 ET).

---

## [Unreleased] - 2026-10-30

### Added
- **4-Room Demo Media Pipeline (EMF 2026 CC BY-SA 4.0):**
  - Ingested and prepared the two remaining full-length conference lectures:
    - `rsa`: "It's the End of RSA as We Know It And I Feel Fine" (EMF 2026, 1192s trimmed, 224 MB)
    - `qrcode`: "A Brief History of the QR Code and other scannable things" (EMF 2026, 970s trimmed, 146 MB)
  - Trimmed cuts and transcoded via `talk-tracks-media:dev` into H.264 (no B-frames, keyframe every 2s) and Opus (48 kHz mono, 20ms frames).
  - Validated upstream SHA-256 source integrity and cleaned up temporary raw video files to reclaim 4+ GB disk space on the VM.
- **Full 6-Track AI Demo Generation:**
  - Completed real-time multi-track generation on the VM under `$8.00` batch cap `~/tt-data/caps/gen-demo.json`:
    - `rsa`: 2,808 captions, 238 Turkish translations, 238 Spanish translations, 238 Arabic translations, 37 chapter markers, 1 slide describe state.
    - `qrcode`: 2,679 captions, 232 Turkish translations, 232 Spanish translations, 232 Arabic translations, 35 chapter markers, 1 slide describe state.
  - Sliced archive outputs and snapshot manifests written to `$TT_DATA/demo/{rsa,qrcode}/`.
- **Offline Subtitle Alignment & Re-segmentation:**
  - Completed offline `retranslate` and `resplit` for Spanish (`es`) and Arabic (`ar`) across `virus` and `dataviz`.
  - Completed offline `retranslate` and `resplit` for Turkish (`tr`) on `rsa`.
- **4-Room Looper Token:**
  - Minted and deployed 30-day relay looper token into `deploy/.env` covering all 4 rooms (`virus`, `dataviz`, `rsa`, `qrcode`) for teacher media, slides, catalog, and agent tracks.

### Changed
- **LLM Client Resilience:**
  - Added automatic retry with exponential backoff (up to 4 attempts) for `httpx.TimeoutException` and `httpx.NetworkError` in `MetaLlm._post` (`agents/src/talk_tracks/llm/meta.py`), preventing transient network read timeouts from interrupting batch translation and generation runs.

### Audited
- **Spend Ledger & Budget:**
  - Cumulative total spend across all project history stands at **$4.6500 USD** against the $100 hackathon ceiling (< 5% budget used).
  - Room generation spends: `gen-rsa` ($1.2023), `gen-qrcode` ($1.1706), `gen-dataviz` ($0.4237), `gen-virus` ($0.3817).
  - Offline revision spend: `revise-rsa` ($0.6960), `revise-virus` ($0.2255), `revise-dataviz` ($0.2250).
