# Talk Tracks

Hackathon build (Meta Global AI Developer Hackathon, due 2026-11-04). Public repo: nothing private (IPs, hostnames,
keys, account details) goes in it. No CI.

Decisions that shape the code are agreed with the owner first: blocking ones through the question prompt, async ones
as ticket files in `tickets/` (the owner writes the answer in the file). Answers that shape the code become MADR
files in the wiki's decisions folder.

## Work as a team

Every task goes to a dedicated agent, the way a team splits responsibilities. A coordinator session does not build;
it briefs, supervises, merges and deploys. The lanes, their files, dependencies and definitions of done are in
`wiki/team.md`, and the dated plan is `wiki/plan.md`.

- The coordinator starts one agent per lane, each in its own worktree and branch. It briefs the agent from
  `wiki/team.md`, supervises it, merges finished branches into `main`, prunes them, and is the only one who deploys
  to the VM.
- Lanes never ask the owner. They return questions to the coordinator, which asks through the question prompt
  (blocking) or files a ticket (async).
- API use is lazy and capped: real Meta calls run only on the VM, through its spend ledger (ceiling $100 overall).

## Artifacts

- Player Mockups: https://claude.ai/artifact/3nZmzbEh1AgsRF7UExrbNr   (clickable sketch of wiki/product/ui-design.md; source in scratch/player-mockups/)
