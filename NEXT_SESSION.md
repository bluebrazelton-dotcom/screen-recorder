# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-29 (post-v1.18). Supersedes the post-v1.16 snapshot.

## Where things stand

- **v1.17 (caption foundation) and v1.18 (caption editor UI) are shipped, pushed,
  and past the owner's initial acceptance pass** (2026-07-29). Commits `b956040`
  (v1.17), `33d8425` (v1.18), `f231287` (acceptance docs). Check `git status`
  first: the REVIEW.md edits recording the #18 keep-decision and the new #21
  queue item may still be uncommitted (suggested message:
  `docs: caption editor kept; queue #21 re-record-from-timestamp as next up`).
- **v1.17** — pure caption logic in `index.html` ("Caption logic (v1.17)"
  section): `parseCaptionTimestamp`/`formatCaptionTimestamp`, `parseVTT`/
  `parseSRT` (best-effort, `skipped` counts, prologue + cue-settings preserved
  verbatim for lossless round-trip), `detectCaptionFormat`, `serializeVTT`/
  `serializeSRT`. Closes nothing in REVIEW; opens item #18's foundation.
- **v1.18** — the open-a-file caption editor: mode switch (`openCaptionEditor`/
  `closeCaptionEditor`, hides recorder UI), open/drag-drop a .webm into the
  app's FIRST real playback `<video controls>` (`#captionVideo`), VTT/SRT
  import, sorted cue-list editing (end>start validated), live `<track>` preview
  (`track.track.mode`, NOT the element's — that was review defect C), IndexedDB
  draft autosave (`DB_VERSION` 2, new `captions` store keyed by
  `name|size|lastModified`, guarded upgrade), export .vtt/.srt through the
  saveFile FSA/download fork with sidecar naming. Recording pipeline and
  streamed save flows untouched; `deleteSession` untouched (drafts key on file
  identity, not sessions).
- **Harness: 115 scenarios / 649 assertions** (`node test.cjs`; scenario
  prefixes now end at DH). Orchestrator review caught 3 defects in the v1.17
  draft and 8 in the v1.18 draft before ship — the review pass is load-bearing,
  keep it (BUILD_LOG entries have the details).

## Decisions made this session (owner, 2026-07-29)

- **Caption editor STAYS.** From-scratch authoring was judged cumbersome; the
  primary workflow is reframed as **import-and-correct** (auto-generate a .vtt
  elsewhere — including browser-local ASR that never uploads the video — then
  fix errors against playback in DidaRec and export the sidecar). Validated by
  the owner with a simulated-ASR test file (import → fix six seeded homophone
  errors → export). The zero-install/no-upload correction niche plus its role
  in #21 justified keeping it.
- **v1.19 (authoring polish: shortcuts, cue chaining, split/merge) is queued
  but NOT next.** Only revisit if from-scratch authoring becomes a real story.
- **#21 is next: re-record from a timestamp** (see below).
- **#19 (user docs + README refresh) and #20 (final-build full regression)**
  are queued for when the feature set stabilizes. README is actively stale
  (still says Chrome-only/FSA-required; Firefox has been primary since v1.9).

## Next session: #21 — re-record from a timestamp (design brief first)

Owner's ask: pause/stop a recording, review it, pick a timestamp, re-record
from that point without losing the whole effort. REVIEW.md #21 has the full
scoping. Start with a design brief session (recon → design → owner sign-off),
NOT code. Key pointers:

- Every hard piece exists: the v1.13 streamed index scanner (cluster
  timestamps + byte offsets) makes truncation a tail-cut at the last cluster
  boundary <= T (tail cuts have no keyframe problem); Continue Recording is
  the append-new-segment-and-stitch flow; the v1.18 editor's player is the
  review/scrub surface.
- Constraints already agreed with the owner: ~1s cut precision (cluster
  granularity); reviewing the unsaved recording assembles it in memory
  (Blob + `makeSeekable` for scrubbing) with a documented ceiling —
  MediaSource streaming is the eventual fix; the seam behaves like today's
  crash-stitch seams.
- Open design question for the brief: soft-delete the discarded tail until
  final save (recoverable takes — also the doorway to multi-take support).
- The truncation primitive must trim a chunk mid-ArrayBuffer (cluster
  boundaries don't align with chunk boundaries). Differential harness tests
  on synthetic WebM are mandatory. This is EBML byte-surgery: Fable designs
  and reviews closely, Sonnet executes (standing arrangement).
- The LIVE recording pipeline stays untouched — truncation operates on stored
  chunks while the recorder is stopped.

## Permanent platform knowledge (unchanged from last snapshot — still true)

- **file://-served Chrome cannot list mic OR camera device names in-app.**
  Verdict flags `micEnumAnonymized`/`camEnumAnonymized` in localStorage gate
  only the dropdowns' Default-slot text. Granted track labels still work.
- **The owner's Chrome exposes `showSaveFilePicker` on file://** (since a
  ~2026-07-29 Chrome update) — saves take the FSA path, no gray download bar,
  by design. Don't chase a missing save-bar as a regression; check
  `'showSaveFilePicker' in window` first.
- **A Bluetooth headset's hands-free profile masquerades as "interference"**
  (8–16 kHz telephony audio). Check the granted track's label before assuming
  a capture regression.

## Read first

- `BUILD_LOG.md` — architecture + version history through v1.18 (the v1.18
  entry documents all 8 review-caught defects); Testing section holds every
  manual acceptance list (that's also the #20 master checklist).
- `REVIEW.md` — queue: #21 (next), #19/#20 (at stabilization), v1.19 (parked).
- `test.cjs` — `npm i fake-indexeddb`, `node test.cjs`, expect 649 assertions.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block (test.cjs
regex-extracts it — a second block breaks the harness). WebM/streamable only.
Don't touch the recording pipeline (~1s-max-loss guarantee) or the v1.11/v1.13
streamed save flows. Firefox is primary — test there, not just Chrome. Faculty
audience: messages suggest an action, never a stack trace. File Edit Rule:
show Blue every proposed change in full and wait for approval before writing
project files (agents draft in scratch, orchestrator reviews and presents).
End with a working page; bump BUILD_LOG and update REVIEW when done.

## Gotchas (learned the hard way; new ones marked ●)

- Don't run index-touching git from a restricted sandbox — stale
  `.git/index.lock`. Read-only checks there, real git in a normal shell.
- The assertion total from `node test.cjs` is ground truth; count
  `await scenario(` calls for the scenario number. Prefixes end at DH.
- ● New caption functions must be added to test.cjs's `__api` exposure line
  (~line 177) to be testable; the vm sandbox also exposes top-level functions
  as `sandbox.<name>`.
- ● `resetState()` in test.cjs must reset any new module-level state (it now
  clears `captionEditorState`, `captionCueRowEls`, banners, file inputs) —
  module-level objects leak across scenarios otherwise.
- ● PowerShell `Measure-Object -Line` skips blank lines — use
  `(Get-Content f).Count` for real line counts (a false red flag cost time).
- ● Grep display can mangle leading `//` into `\` — check raw bytes before
  declaring corruption (a false alarm this session).
- The harness proves logic; only a browser proves pixels/audio/permissions —
  v1.18's `TextTrack.mode` fix is manual-only verifiable (BUILD_LOG Testing
  list, item 3).
- Staging can serve a stale copy — confirm with a fresh shell read.
