# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-28 (post-v1.13). An Aegis session also has the fuller
`project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- v1.13 is committed and pushed (`20b3ea8`): the streaming multi-segment stitch.
  `saveSessionsStreamedStitch` (FSA + download sinks) streams Continue Recording
  chains and multi-crash recovery with bounded memory, byte-identical to the old
  buffered `concatenateWebM`+`makeSeekable` output (differential-tested). Any
  doubt in the scan bails to streamed separate-parts saves — never the buffered
  path. Rider 1: the last chunk-store `getAll` is gone (`getSessionChunks`
  deleted). Rider 2: the blocking `confirm()` in `stitchAndSave` is replaced by
  the in-app `#stitchFallback` banner. BUILD_LOG Known Limitation #1 closed;
  REVIEW #5 closed in full; REVIEW #10 closed. Harness: 54 scenarios /
  344 assertions (new AR–AX; D, S reseeded with real WebM; E/E2/T updated for
  bail-not-throw semantics).
- Phase 3 owner acceptance (2026-07-28): **Firefox — the primary browser —
  passed across the board.** Chrome: the recording saved, but the microphone
  didn't pick up the owner's voice — only interference-like sounds. That is a
  CAPTURE problem, not a save/stitch problem (v1.13 touched no recording-pipeline
  code), now queue item 1 below.
- Standing preference (in Aegis memory too): run DidaRec work as orchestrator +
  Sonnet 5 subagents (`Agent` tool, `model: "sonnet"`) — Fable plans/reviews/
  presents, Sonnet drafts/explores/runs tests in a scratch copy. The File Edit
  Rule still applies at the orchestrator level.
- Standing lesson from 07-23 (three bugs caught ONLY in a real browser): the
  harness proves logic; only a browser proves pixels — and now, only a browser
  proves audio. Never skip the browser pass.

## Read first

- `BUILD_LOG.md` — architecture + full version history (through v1.13).
- `REVIEW.md` — the build queue and what's fixed.
- `test.cjs` — Node harness (54 scenarios / 344 assertions). `npm i fake-indexeddb`
  then `node test.cjs`. Extend it; don't bypass it.
- `STREAMING_STITCH_HANDOFF.md` / `STREAMING_SAVE_HANDOFF.md` — how the last two
  passes were run (untracked working docs).

## Ground rules (unchanged)

Zero dependencies, single `index.html`, no build step. WebM / streamable only. Don't
touch the recording pipeline (~1s-max-loss crash guarantee) or the v1.11/v1.13
streamed save flows. Firefox is the primary browser — test there, not just Chrome.
Faculty audience: messages suggest an action, never a stack trace. Show Blue every
proposed change in full and wait for approval before writing any file. End with a
working page; bump the version in `BUILD_LOG.md` and update `REVIEW.md` when done.

## Open queue (priority order)

1. **Mic device selection is broken; Chrome records interference instead of voice**
   (found during v1.13 acceptance; diagnosed with the owner 2026-07-28). Owner-
   confirmed findings, BOTH browsers: the mic dropdown only ever shows
   "Default microphone" / "Microphone 1" placeholders and never upgrades to real
   device names, even after a grant; on Chrome the dropdown doesn't populate
   until recording starts. Code-confirmed mechanism (`enumerateDevices` /
   `captureMic` / `onDeviceSelected`, index.html ~860–975): pre-grant,
   browsers return blank labels AND blank deviceIds, so the placeholder options
   get `value=""` — colliding with the Default option — and selecting one is a
   no-op (falsy `state.selectedMic` → no deviceId constraint reaches
   getUserMedia). The v1.12 post-grant fire-and-forget re-enumeration
   (captureMic → enumerateDevices) SHOULD rebuild the list with real names but
   demonstrably doesn't land in the UI — that's the core bug to find. With
   selection inert, Chrome falls back to its OS default input (default vs
   communications-device split, or a loopback-style device), which records
   interference; Firefox's default happens to be the real mic, which is why
   Firefox "works". Scope for the fix session: make the post-grant label
   upgrade actually reach the dropdown; stop offering fake pre-grant choices
   with empty ids; then verify Chrome records real voice once a real device is
   selectable. Recording pipeline untouched — enumeration/selection UI only;
   don't regress the v1.12 guarantees (zero prompts at load, lazy grant, blank
   re-enumeration never overwrites a good name); real-browser pass in BOTH
   browsers is the acceptance (only a browser proves audio).
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
- Scenario-count bookkeeping drifts (earlier docs said "37 scenarios" when there
  were 46 labels) — the assertion total from `node test.cjs` is ground truth;
  count `await scenario(` calls if you need the scenario number.
