# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-27 (post-v1.12.2). An Aegis session also has the fuller
`project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- v1.12.1 is committed and pushed (`9a65827`) — the 07-23 close-out's step zero is
  done.
- v1.12.2 = `downloadPendingIds` polish (old queue item 1): a 2nd unresolved Firefox
  download now APPENDS to the confirm bar (ID dedupe + `downloadPendingFiles`
  counter in the message) instead of overwriting the 1st's IDs. Harness green
  (31 scenarios / 208 assertions, new scenario AK). **Blue's real-Firefox
  acceptance — two unconfirmed downloads back-to-back — may still be pending;
  confirm before building on top.** Check `git log -1` for a v1.12.2 message; if
  absent, the working tree holds it — commit+push from a normal shell (suggested
  message in BUILD_LOG's v1.12.2 entry).
- v1.12 = REVIEW P2 #7 closed: zero permission prompts at load; grants happen lazily
  at first webcam/mic use; labels upgrade on grant and a blank re-enumeration never
  overwrites a good name; `state.sources.camera` defaults off (the root cause of
  camera-only being unreachable); the at-least-one guard explains itself.
- v1.12.1 = camera-only preview actually renders: Screen-off composites the live
  camera; leaving camera-only restores the placeholder.
- Standing lesson from 07-23 (three bugs caught ONLY in a real browser): the harness
  proves logic; only a browser proves pixels — assert what the viewer SHOWS, and
  never skip the browser pass.

## Read first

- `BUILD_LOG.md` — architecture + full version history (through v1.12.1).
- `REVIEW.md` — the build queue and what's fixed.
- `test.cjs` — Node harness (31 scenarios / 208 assertions). `npm i fake-indexeddb`
  then `node test.cjs`. Extend it; don't bypass it.
- `PERMISSION_UX_HANDOFF.md` / `STREAMING_SAVE_HANDOFF.md` — how the last two passes
  were run (untracked working docs).

## Ground rules (unchanged)

Zero dependencies, single `index.html`, no build step. WebM / streamable only. Don't
touch the recording pipeline (~1s-max-loss crash guarantee) or the v1.11 streamed
save flow. Firefox is the primary browser — test there, not just Chrome. Faculty
audience: messages suggest an action, never a stack trace. Show Blue every proposed
change in full and wait for approval before writing any file. End with a working
page; bump the version in `BUILD_LOG.md` and update `REVIEW.md` when done.

## Open queue (priority order)

1. Streaming stitch — multi-segment saves still buffer everything (BUILD_LOG Known
   Limitation #1, ~2–3h ceiling). Hard plumbing: wants its own handoff brief like
   STREAMING_SAVE_HANDOFF.md, and Fable-grade routing (window closes Aug 19).
2. Tier 1: caption editor with VTT/SRT import/export (highest-value open item — ADA
   Title II; prior-art recon: borrow laubonghaudoi/subtitle-editor, MIT), chapter-
   marker hotkeys, sidecar export convention. The caption editor deserves its own
   brief and likely multiple sessions.

## Gotchas (learned the hard way)

- Don't run index-touching git (`status`/`add`/`commit`) from a restricted sandbox —
  stale `.git/index.lock` blocks later git; read-only checks there, real git in a
  normal shell. (Blue's machine once had a stale `.git/HEAD.lock` from an interrupted
  git — same cure: `rm` it.)
- Staging can serve a stale copy — confirm with a fresh shell read.
- `.gitignore` covers `node_modules/`, `_to_delete/`, `*.webm`, `*_HANDOFF.md`,
  `*_completion_report.md`.
