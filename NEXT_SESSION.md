# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-08-03 (post-v1.22.2). Supersedes the post-v1.21.2
snapshot.

## Where things stand

- **Two issues CLOSED today, four releases shipped and pushed** (origin/main
  current): v1.21.3 (Screen toggle lit state tracks the live capture +
  cancelled re-selection resync), v1.22 (#22 session 1: refineCutToBlock /
  readSessionByteRange / computeCutPlan segOffsetMs+clusterIndex + DZ–ED
  differentials), v1.22.1 (#22 session 2: reviewCutFromHere wire-in +
  EE–EH + the DO keep-whole re-pin), v1.22.2 (dark-Screen-click-opens-
  picker + Undo's own flex row).
- **#21 CLOSED**: the owner's full consolidated pass (Part R + F1–F15
  Firefox + C1–C13 Chrome) PASSED on v1.21.2. Chrome's "no all-set banner"
  is designed behavior (FSA write is confirmed programmatically; the
  confirm bar is Firefox's unverifiable-download path only).
- **#22 CLOSED**: block-precision cut shipped in two sessions and
  owner-accepted (B1–B6, both browsers) — cut lands within a second of the
  scrubbed time (was ~7.5s Firefox / ~1s Chrome). v1.22.2's two follow-up
  findings also owner-verified same day.
- **Harness: 149 scenarios / 1053 assertions** (`node test.cjs`; scenario
  prefixes end at EI).
- Working pattern that held all day: Sonnet drafts in scratch (and
  pre-verifies by applying to scratch COPIES and running the real harness —
  keep requiring that, it caught nothing wrong but proves the anchors),
  orchestrator reviews (caught 1 real defect per session: the keptEndMs
  floor in s1; the camera-only-unreachable regression in v1.22.2 was
  caught by scenario AH at apply time), owner approves before any repo
  write, owner accepts in a real browser after.

## Permanent design knowledge (new ● + carried forward)

- ● **Both browsers' MediaRecorders write UNKNOWN-SIZE clusters** (Chrome
  1-byte 0xFF, Firefox 8-byte all-ones — scenarios N/O/AL). This is why
  #22 needed zero byte-surgery: a block-boundary truncation just ends at
  EOF/next cluster, the same shape every crash tail already has.
  refineCutToBlock REFUSES known-size clusters (scenario-AX asymmetry) and
  falls back to Rule A.
- ● **The keep-whole promotion is intended behavior**: T in the gap after
  a cluster's last block keeps that whole cluster (cut byte = cluster end)
  instead of Rule A's whole-cluster drop. DO was re-pinned for it via the
  expectedBlockCut oracle; its undo/data-loss assertions are unmodified.
- ● **The dark Screen button has FOUR click meanings** (scenario EI):
  webcam off + no stream → opens the picker; webcam on + no stream →
  camera-only entrance (v1.12 — hijacking this makes camera-only
  UNREACHABLE since Record is disabled in screen mode without a stream);
  lit → toggle-off; intent-off → re-enable intent. Touch toggleSource only
  with AH/EI in view.
- ● FF153: audio codec in mimeType + no audio track = silent zero-chunk
  recorder (v1.21.2 fix: opus only when audio present; scenario DX). FF
  has no vp9. FF first blob can be ~7.5s late (start-verify grace). FF
  clusters ~7.5s vs Chrome ~1s. FF storage can wedge (watchdogs guard).
- file://-Chrome can't list device names; owner's Chrome has
  showSaveFilePicker on file://; Bluetooth hands-free masquerades as
  interference.
- Watch for **Firefox 154** (~1–2 weeks): may fix the upstream opus bug;
  v1.21.2's fix and the watchdogs stay regardless.

## Load-bearing invariants (do not break)

- Seam offsets = previous segment's CONTENT END:
  `Math.max(lastClusterMaxBlockTime, maxClusterTs) + SEAM_GAP_MS` (33ms),
  in LOCKSTEP in concatenateWebM / scanSegmentsForStitch / computeCutPlan;
  DS assertNoOverlap enforces. refineCutToBlock's keptEndMs FLOORS at the
  cluster timestamp for the same lockstep (DZ pins it) — don't remove the
  Math.max(0, …).
- Refinement in reviewCutFromHere is an ENHANCEMENT: its own try/catch
  falls back to Rule A's byte/time on any failure (EF pins it); seam-gap/
  noop plans never attempt the ranged read (EH pins it). Never let a
  refinement error surface to the user.
- `claimFinalize()` makes onstop / stop-watchdog / salvage mutually
  exclusive; finalizeStarted SURVIVES resetUI, resets only in
  startRecording. onstop clears the stop watchdog only AFTER winning the
  claim. All salvage paths force stopMode='save'.
- Undo re-record arms the FULL pane chain (restoreSegments) — DO/EE pin
  it; undo of a re-cut restores the PREVIOUS marker exactly.
- confirmDownloadArrived: mark-completed-first, background delete.
- The review-pane preview is the ONE legitimate concatenateWebM caller.
- New reviewState fields go into resetState().

## Gotchas (unchanged ones compressed)

- New vm module state must be `var`; timing consts go in ORIG_TIMINGS AND
  resetState's timer-clearing block. ORIG/resetState now also
  capture/restore getDisplayMedia (DY) — mirror that pattern for any new
  navigator mock a scenario swaps.
- PowerShell Get-Content/Set-Content mangles this repo's BOM-less LF files
  — Edit tools or bash/sed only.
- Grep tool can render `//` as `\` (display artifact) — Read before
  believing a "syntax error".
- Scenarios AL/AM/AN pin literal timestamp/Duration strings; AG is now
  the lit-guard case (stream survives); EI pins the four Screen-click
  meanings.
- Real-browser behavior is invisible to the harness — owner acceptance
  gates every UI-flow feature. Console-paste diagnostics remain the field
  tool of choice.

## Queue

- **#25 (next): review-pane take controls** — (a) "Redo last take"
  (whole-segment cut at segIndex=last via the existing cutAtByte===0
  machinery; exact precision; show only with 2+ segments), (b) typed
  `m:ss` timestamp beside "Re-record from here" feeding the same
  computeCutPlan path — which now inherits #22's block precision
  automatically, so the old cluster-granularity caveat is GONE from the
  UI copy. Sonnet drafts, orchestrator reviews, owner approves/accepts.
- **#23 pause → change screens → resume** — scoped in REVIEW #23 (canvas
  compositor makes the video swap pipeline-free; audio-mix reconnection is
  the one new piece; affordance only while paused).
- **#19 (docs/README) + #20 (final full regression)** at stabilization.
  #19 now owes: save-first-then-open caption workflow note; the
  scrub-back-to-redo note (obsolete if #25(a) ships first); the
  Chrome-vs-Firefox save-flow difference is already on its list.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block. WebM only.
Don't touch the recording pipeline's byte behavior or the streamed save
flows (differentials enforce). Firefox first. Faculty tone. Delegate
drafting to Sonnet agents; orchestrator reviews EVERYTHING before it
ships. File Edit Rule: agents draft in scratch; orchestrator presents in
full, waits for approval. End with a working page; bump BUILD_LOG and
REVIEW when done.
