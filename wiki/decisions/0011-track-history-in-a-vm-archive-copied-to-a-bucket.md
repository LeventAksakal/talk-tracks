---
status: accepted
date: 2026-10-28
decision-makers: project owner
---

# A room's track history is archived on the VM and copied to a cloud bucket

## Context and Problem Statement

Rewind (decision 0007) and agent restart (decision 0009) both need every room's tracks stored somewhere that serves
viewers and restarting agents and survives the VM. The relay is a live cache: it keeps the newest group plus about
30 s, and only while the publisher is live ([ticket 0015](../../tickets/0015-track-history-store.md)).

## Considered Options

* An archiver on the VM, replicated to a cloud bucket
* A dedicated cache server on a second VM (moq-relay cluster or Valkey)
* An archiver writing straight to the bucket, with viewers reading history from it
* History on the VM only, with no backup

## Decision Outcome

Chosen: an archiver on the VM, replicated to a cloud bucket.

* A long-running archiver (the existing recorder, grown up) follows every room under `talk/**`. It writes media
  segments and snapshot timelines to the VM's disk.
* Caddy serves those files to rewinding viewers. Restarting agents seed from the archive's latest snapshot of their
  own track.
* Each finished segment is copied to a Cloud Storage bucket within seconds. The bucket name and project stay out of
  the repo, and the VM's service account can write to that one bucket only.
* After losing the VM: a new VM, `git clone`, copy the bucket back, `compose up`.

Reading history straight from the bucket stays a later switch if rewind load ever matters.

### Consequences

* Good, because one process we mostly have already, plus one bucket, serves both rewind and agent restore.
* Good, because history outlives the VM.
* Bad, because the relay and the archive share one VM: viewers are down until a replacement VM is restored (about
  10 minutes by hand).
* Bad, because up to about 10 s of history, not yet copied to the bucket, can be lost with the VM.
