# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-29 (post-v1.16). An Aegis session also has
the fuller `project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- **v1.15 and v1.16 are owner-accepted (both browsers, 2026-07-29) but may not be
  committed yet** — check `git status` first; if dirty, the suggested commit
  messages are in their BUILD_LOG entries. v1.14 (`4cfdf4c`) was the last push.
- **v1.15** — camera-side honest labels + mic toggle defaults OFF. The v1.14 mic
  machinery generalized: shared `applyDeviceDefaultText(type)`, camera surfaces
  the granted video track's own label ("Camera: <label>") via
  `state.lastCameraLabel`, separate `camEnumAnonymized` verdict set/cleared in
  `captureCamera` (which now awaits its internal enumerate). Mic defaults OFF at
  load, matching the webcam. Closes REVIEW.md #16.
- **v1.16** — the mic hold. Toggle-ON acquires AND HOLDS the mic stream
  (`acquireMicHold` / `state.heldMicStream` / `state.heldMicDeviceId`), mirroring
  the webcam preview; `captureMic` reuses the live, selection-matching hold at
  record with ZERO getUserMedia calls, so Record starts instantly and prompt-free
  — the permission pop-up moved to toggle-ON, where in file:// Chrome it doubles
  as the device picker. Recording stop preserves the hold while the toggle is on
  (`releaseMicRecordingRef`, which also promotes a mid-recording fallback stream
  into the new hold); denial reverts the toggle with failure-matched copy;
  `primeMicLabels` and the passive prime are GONE; `micEnumAnonymized` now
  governs only the dropdown's Default-slot text. Mic goes hot at toggle-ON
  (browser indicator pre-recording) — by design, matches the camera. Closes
  REVIEW.md #17.
- Harness: 86 scenarios / 472 assertions (v1.15 added BL–BR, v1.16 added BS–CD
  and deliberately rewrote ten v1.14-era scenarios that encoded prime-then-stop).
  `node test.cjs` prints the assertion total, not a scenario count — see Gotchas.
- Recording pipeline (~1s-max-loss guarantee) and v1.11/v1.13 streamed save
  flows untouched by both versions; v1.16's closest approach is
  `releaseMicRecordingRef` in `cleanupStreams`, which is stream teardown only.
- Standing preference (in Aegis memory too): run DidaRec work as orchestrator +
  Sonnet 5 subagents (`Agent` tool, `model: "sonnet"`) — Fable plans/reviews/
  presents, Sonnet drafts/explores/tests in a scratch copy. The File Edit Rule
  still applies at the orchestrator level. This session ran that way for both
  versions; orchestrator review caught two real defects in the v1.16 draft (a
  stale-selection race around the grant `await`, and permission-blaming copy on
  device failures) — the review pass earns its keep.

## Permanent platform knowledge (read before touching mic/camera/save code)

- **file://-served Chrome cannot list mic OR camera device names in-app, ever.**
  Confirmed Chrome 150, 2026-07-28: `enumerateDevices()` returns blank deviceId
  AND label at every stage, even during a live granted stream — file:// origins
  never persist a `getUserMedia` grant. The per-kind verdict flags
  (`micEnumAnonymized`, `camEnumAnonymized` in localStorage) record this so the
  dropdowns explain themselves; since v1.16 they gate NO prompting behavior,
  only the Default-slot text. The granted track's own `.label` still works and
  is surfaced ("Microphone: <device>" / "Camera: <device>"). Serving over
  http(s) restores persisted grants and full named dropdowns.
- **file:// Chrome NOW EXPOSES `showSaveFilePicker` (owner console check
  2026-07-29; earlier builds lacked FSA on file://).** Saves in Chrome therefore
  take the FSA picker path — write confirmed by the API, `'saved'` result — and
  the gray `#downloadConfirm` bar does NOT appear, by design; that bar only
  backs the unverifiable anchor-download path (still Firefox's route). This was
  reported as a missing banner during v1.16 acceptance and diagnosed as a Chrome
  auto-update, not an app change (differential harness repro showed v1.15/v1.16
  byte-identical through the whole stop-and-save flow). Don't chase a missing
  Chrome save-bar as a regression — check `'showSaveFilePicker' in window` first.
  Corollary: Chrome's per-recording record-start pop-ups are also gone now —
  the toggle-ON grant is held and reused across recordings (v1.16).
- **A Bluetooth headset's hands-free profile masquerades as "interference."**
  8–16 kHz telephony-band audio from `Headset (… Hands-Free AG Audio)` was the
  original v1.13-era "interference/no-voice" bug. If it's ever heard again,
  check which physical device the granted track's label names before assuming a
  capture regression.

## Read first

- `BUILD_LOG.md` — architecture + full version history (through v1.16, including
  the FSA field note).
- `REVIEW.md` — the build queue and what's fixed (through #17).
- `test.cjs` — Node harness (86 scenarios / 472 assertions). `npm i fake-indexeddb`
  then `node test.cjs`. Extend it; don't bypass it.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, no build step. WebM / streamable only. Don't
touch the recording pipeline (~1s-max-loss crash guarantee) or the v1.11/v1.13
streamed save flows. Firefox is the primary browser — test there, not just Chrome.
Faculty audience: messages suggest an action, never a stack trace. Show Blue every
proposed change in full and wait for approval before writing any file. End with a
working page; bump the version in `BUILD_LOG.md` and update `REVIEW.md` when done.

## Open queue (priority order)

1. **Tier 1: caption editor with VTT/SRT import/export** (highest-value open item —
   ADA Title II; prior-art recon: borrow laubonghaudoi/subtitle-editor, MIT).
   Deserves its own brief and likely multiple sessions.
2. Chapter-marker hotkeys, sidecar export convention (Tier 1 remainder).

## Gotchas (learned the hard way)

- Don't run index-touching git (`status`/`add`/`commit`) from a restricted sandbox —
  stale `.git/index.lock` blocks later git; read-only checks there, real git in a
  normal shell. (Blue's machine once had a stale `.git/HEAD.lock` from an
  interrupted git — same cure: `rm` it.)
- Staging can serve a stale copy — confirm with a fresh shell read.
- `.gitignore` covers `node_modules/`, `_to_delete/`, `*.webm`, `*_HANDOFF.md`,
  `*_completion_report.md`.
- Scenario-count bookkeeping drifts — the assertion total from `node test.cjs` is
  ground truth; count `await scenario(` calls if you need the scenario number.
- The harness proves logic; only a browser proves pixels/audio/permissions — and
  (new this session) the owner's environment can change UNDER you: a Chrome
  auto-update flipped save-path behavior mid-project. When "it changed and we
  didn't touch it," a differential harness repro (same flow, both versions) plus
  a one-line owner console check settles it cheaply. `repro_banner.cjs` in this
  session's scratch was the pattern: 2×2 (version × save-mode) over the exact
  reported flow.
