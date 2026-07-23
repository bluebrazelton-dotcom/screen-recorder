# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-23 (post-v1.12). An Aegis session also has the fuller
`project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- **v1.12 built and tested, NOT YET PUSHED** — `git log` still shows `8bb8a74` (v1.11)
  as the tip. `index.html`, `test.cjs`, `BUILD_LOG.md`, `REVIEW.md` all have
  approved, written changes on disk; nothing has been committed. Commit + push is
  Blue's step (per the git-sandbox gotcha below).
- v1.12 = REVIEW P2 #7 (load-time permission prompt) + camera-only discoverability,
  one session, both closed:
  - Dropped the temp `getUserMedia` from `enumerateDevices()` — it now enumerates
    directly, prompt-free, at load and on `devicechange`.
  - `captureCamera()`/`captureMic()` (the only two real `getUserMedia` sites, reached
    via the Webcam toggle and record-start) each re-enumerate on grant to upgrade
    device labels while the permission is live.
  - A blank re-enumerate (Firefox blanks labels once a granting stream's tracks stop)
    never overwrites a known-good label.
  - Camera-only: diagnosis differed slightly from the original hypothesis — default
    state has `camera: true` at load but no stream starts until Webcam is explicitly
    toggled, so Screen-off silently reaches camera-only with no preview, and a
    follow-up Webcam click (trying to "turn it on") actually turns it off, hitting
    the at-least-one-source guard with zero explanation. Fix: the guard now always
    explains itself via `showError()`, and entering camera-only via Screen-off
    auto-starts the camera preview. Full diagnosis in BUILD_LOG v1.12.
- Harness now 40 scenarios / 200 assertions, all green (`node test.cjs`).
- **Real-browser acceptance NOT yet run** — zero-prompt Firefox load, label upgrade,
  camera-only end-to-end (both browsers) is the manual test in BUILD_LOG v1.12's
  Testing section. This is Blue's step; nothing in this pass can substitute for it.

## Read first

- `BUILD_LOG.md` — architecture + full version history (v1.12 entry has the full
  diagnosis for both fixes).
- `REVIEW.md` — the build queue; #7 now marked fixed.
- `test.cjs` — Node harness (40 scenarios / 200 assertions). `npm i fake-indexeddb`
  then `node test.cjs`. Extend it; don't bypass it.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, no build step. WebM / streamable only. Don't
touch the recording pipeline — the ~1s-max-loss crash guarantee lives there. Firefox
is the de-facto primary browser. Faculty audience: messages suggest an action, never
a stack trace. Show Blue every proposed change in full and wait for approval before
writing any file. End with a working page; bump BUILD_LOG.md + update REVIEW.md.

## Open queue (priority order)

1. **Commit + push v1.12** (Blue's step) and run real-browser acceptance — do this
   before anything else in the next session if it hasn't happened yet.
2. `downloadPendingIds` polish — 2nd unresolved Firefox download overwrites the 1st's
   confirm bar (safe — banner backstop — but append would be cleaner).
3. Streaming stitch (multi-segment saves still buffer; Known Limitation #1).
4. Tier 1: chapter-marker hotkeys, caption editor (VTT/SRT import/export — highest-
   value open feature), sidecar export convention.

## Gotchas (learned the hard way)

- Don't run index-touching git (`status`/`add`/`commit`) from a restricted sandbox —
  stale `.git/index.lock` blocks later git; use read-only checks there, real git in a
  normal shell. If hit: `rm .git/index.lock`.
- Staging can serve a stale copy — confirm with a fresh shell read.
- `.gitignore` covers `node_modules/`, `_to_delete/`, `*.webm`, `*_HANDOFF.md`,
  `*_completion_report.md`.
