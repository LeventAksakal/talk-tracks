---
status: accepted
date: 2026-10-29
decision-makers: project owner
---

# The benchmark runs on the production VM, resized to 4 vCPUs

## Context and Problem Statement

The benchmark's VM runs take about 2.5 hours and need about 3 CPU cores and 1.5 GB of RAM. The production VM has 2
shared vCPUs and also runs the relay, the demo rooms and the agents, so measuring on it as it is would distort the
numbers and slow the demo rooms. Where do the runs happen on Sun Nov 1?
([Ticket 0018](../../tickets/0018-benchmark-machine.md))

## Considered Options

* A temporary 4-vCPU twin VM, deleted after the runs.
* **Resize the production VM to 4 vCPUs for the rest of the hackathon.**
* Run on the production VM as it is, with the demo looper stopped.

## Decision Outcome

Chosen: resize the production VM to 4 vCPUs.

### Consequences

* Good, because the numbers come from the production box itself.
* Good, because the demo gains headroom for judge rooms, the archive and the VM load test planned for Sun Nov 1.
* Bad, because the resize costs about a minute of downtime.
* Bad, because it costs roughly $2-3 a day more in cloud credit (not the Meta budget), about $15-20 to Nov 4.
