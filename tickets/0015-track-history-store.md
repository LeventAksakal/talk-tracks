---
status: closed
created: 2026-10-28
tags: [architecture, storage, failover, rewind]
---

# Where does a room's track history live, so it survives restarts and the VM?

## Question
Which component stores every room's tracks (media and agent snapshots), serves the history to rewinding viewers and
to restarting agents, and keeps it when the VM is lost?

## Context
Decisions 0007 (rewind from a static archive) and 0009 (agents restart from durable history) both need it. What holds
today:

- **API use does not grow with viewers.** Each agent publishes once, and the relay fans out. A late joiner gets the
  latest snapshot from the relay, and a snapshot is self-contained, so it needs no history and no API call.
- **The relay is a live cache, not an archive.** It keeps the newest group plus about 30 s, and only while the
  publisher is live. Raising its memory limits does not survive a relay or VM restart.
- **Agent state is on the VM's disk.** Captions save their last 40 lines to `~/tt-data/state`, and nothing is
  backed up off the box.
- **A recorder already exists.** `record` subscribes to a room and writes the snapshot timeline; `generate` uses it
  for the demo lectures.
- **Sizes.** Agent tracks are small: kilobytes per minute. Speaker audio is about 32 kbit/s, about 15 MB an hour.
  Video at 1–2 Mbit/s is about 0.5–1 GB an hour.

## Options
- **A. An archiver on the VM, replicated to a cloud bucket.**
  - What it is: a long-running archiver (the recorder, grown up) follows every room under `talk/**`. It writes
    media segments and snapshot timelines to disk, Caddy serves them for rewind, and each finished segment is copied
    to a Cloud Storage bucket within seconds.
  - Restarting agents seed from the archive's latest snapshot. A new VM restores from the bucket.
  - Cost: one new process and one bucket, plus the bucket's storage. Built from parts we already have.
  - Weakness: the relay and archive are still one VM, so viewers have downtime until a VM comes back. About the last
    10 s of history can be lost.
- **B. A dedicated cache server.**
  - What it is: a second VM holds the history. It is either a second moq-relay in a cluster, with large caches, or a
    key-value store such as Valkey with append-only persistence. It answers history requests over MoQ or HTTP.
  - Strength: history survives the first VM, and the MoQ-native version is closer to the protocol's
    relay-as-cache idea.
  - Weakness: another machine to run and secure. Memory caps how much it can hold. moq-relay's FETCH limits still
    apply to old groups, and in-memory still needs a backup.
- **C. Archive straight to the bucket and serve history from it.**
  - What it is: as in A, the archiver writes to the bucket, but there is no local copy. Viewers fetch history from
    the bucket over HTTPS, publicly readable or through a CDN.
  - Strength: history serving costs the VM nothing and survives anything that happens to it.
  - Weakness: a cross-origin source, so the bucket needs CORS and CORP headers (the site is cross-origin isolated).
    Every rewind adds a little latency, and a public bucket needs care.
- **D. Keep it on the VM only.** No backup. The simplest, but it fails the owner's requirement that history outlive
  the VM.

## Recommendation
A, with C's direct reads as a later switch if rewind load ever matters.

- It is one process we mostly have already, plus one bucket.
- It serves rewind (0007) and agent restore (0009) from the same files.
- Restore after losing the VM: a new VM, `git clone`, copy the bucket back, `compose up`. About 10 minutes by hand,
  with at most about 10 s of history lost.
- B buys "history stays readable while the VM is down" at the price of a second machine. For a one-week hackathon
  build, recreating the VM is enough.

Open detail for A: the bucket name and project are kept out of the repo, like the hostname, and the VM's service
account gets write access to that one bucket only.

## Answer
A: an archiver on the VM, replicated to a cloud bucket (2026-10-28). Recorded as decision
[0011](../wiki/decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md).
