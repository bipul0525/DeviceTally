Synthetic test data shaped like Claude Code 2.1.283 transcripts (no real content).

- `transcripts/session.jsonl`: two prompts, a meta line, an automated task notification (not a prompt), a tool result, one reply with a 1-hour cache split (`msg_B`), one reply written on two lines with growing counts (`msg_A`), a `<synthetic>` error line, two titles.
- `transcripts/subagent.jsonl`: a subagent file for the same session.
- `project-key.json`: git remote -> project key vectors.
- `transcripts/interrupted.jsonl`: a turn the user stopped in the VS Code extension (a declined tool, then `[Request interrupted by user for tool use]`, then the bookkeeping lines Claude Code writes after it). Claude Code runs no Stop hook for it.
