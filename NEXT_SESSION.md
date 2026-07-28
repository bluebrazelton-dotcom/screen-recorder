# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-27 (post-v1.12.2). An Aegis session also has the fuller
`project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- v1.12.1 is committed and pushed (`9a65827`) — the 07-23 close-out's step zero is
  done.
- v1.12.2 is committed and pushed (`05222cd`), Blue's real-Firefox acceptance
  passed: a 2nd unresolved Firefox download now APPENDS to the confirm bar (ID
  dedupe + `downloadPendingFiles` counter in the message) instead of overwriting
  the 1st's IDs, and filenames gained seconds (same-minute saves no longer
  collide). Harness green (31 scenarios / 208 assertions, new scenario AK).
- Standing preference (in Aegis memory too): Blue wants future DidaRec work run
  as orchestrator + Sonnet 5 subagents (`Agent` tool, `model: "sonnet"`) to save
  tokens — Fable plans/reviews/presents, Sonnet drafts/explores/runs tests. The
  File Edit Rule still applies at the orchestrator level.
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
- `test.cjs` — Node harness (37 scenarios / 268 assertions). `npm i fake-indexeddb`
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

1. Streaming stitch — IN PROGRESS. Read `STREAMING_STITCH_HANDOFF.md` (design ratified
   by Blue 2026-07-27, incl. Rider 2 = REVIEW #10 confirm() replacement). Phase 0
   (oracle, AL–AO, `57dd209`) and Phase 1 (scanner + plan, AP–AQ; harness now 37
   scenarios / 268 assertions) are DONE and pushed. Phase 1 landed
   `webmRewriteClusterHeader` (one shared rewrite implementation, 8-byte marker
   canonicalization preserved), the clusters-only scanner mode
   (`createWebmStreamScanner({ clustersOnly, timeOffset, videoTrack })` — videoTrack
   is SEGMENT 1's, oracle fidelity), and `buildStitchPlanParts` (→ `{head,entries,cues}`
   or `{bail:reason}`). All unreachable from save flows; no version bump yet — v1.13's
   BUILD_LOG entry comes with Phase 2. Next: Phase 2 — wire the sinks
   (`saveSessionsStreamedStitch` FSA + download, `stitchAndSave`/`recoverRecording`
   switch, bail → streamed parts, Riders 1+2), per HANDOFF §3.3–3.5/§5. Phase 2 notes:
   plan entries carry `seg` index for the per-segment chunk walks; the
   truncated-known-size-cluster bail branch in clusters-only mode has no dedicated
   scenario yet — add one when the sinks make it drivable. Window closes Aug 19.
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
