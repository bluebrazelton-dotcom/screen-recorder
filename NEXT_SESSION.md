# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-23 (post-v1.12.1). An Aegis session also has the fuller
`project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- **Step zero — check the tip.** v1.12 is pushed (`c20b9a6`). v1.12.1 (camera-only
  preview fix: ~15 lines in `index.html`, harness + BUILD_LOG updates) was built and
  accepted by Blue in both browsers, but may not be committed yet: if `git log -1`
  doesn't show a v1.12.1 message, the working tree holds it — commit+push first, from
  a normal shell (suggested message in BUILD_LOG's v1.12.1 entry).
- v1.12 = REVIEW P2 #7 closed: zero permission prompts at load; grants happen lazily
  at first webcam/mic use; labels upgrade on grant and a blank re-enumeration never
  overwrites a good name; `state.sources.camera` defaults off (the root cause of
  camera-only being unreachable); the at-least-one guard explains itself.
- v1.12.1 = camera-only preview actually renders: Screen-off composites the live
  camera; leaving camera-only restores the placeholder.
- Everything Bubo-cross-checked; Blue's real-browser acceptance passed. Three bugs
  today were caught ONLY in a real browser (auto-start regression, blank preview,
  dead canvas). The harness proves logic; only a browser proves pixels — assert what
  the viewer SHOWS, and never skip the browser pass.

## Read first

- `BUILD_LOG.md` — architecture + full version history (through v1.12.1).
- `REVIEW.md` — the build queue and what's fixed.
- `test.cjs` — Node harness (30 scenarios / 203 assertions). `npm i fake-indexeddb`
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

1. `downloadPendingIds` polish — a 2nd unresolved Firefox download overwrites the
   1st's confirm bar (safe — recovery-banner backstop — but append would be cleaner).
   Small.
2. Streaming stitch — multi-segment saves still buffer everything (BUILD_LOG Known
   Limitation #1, ~2–3h ceiling). Hard plumbing: wants its own handoff brief like
   STREAMING_SAVE_HANDOFF.md, and Fable-grade routing (window closes Aug 19).
3. Tier 1: caption editor with VTT/SRT import/export (highest-value open item — ADA
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
