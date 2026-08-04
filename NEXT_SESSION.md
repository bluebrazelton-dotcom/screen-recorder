# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-08-04 (post-v1.23, #25 CLOSED). Supersedes the
post-v1.22.2 snapshot.

## Where things stand

- **v1.23 SHIPPED (#25, both parts, one session): review-pane take
  controls.** (a) "Redo last take" — one click discards the newest
  segment whole and re-arms continue-recording at its start; visible only
  with 2+ segments, disabled (not hidden) under the scansOk gate. (b) A
  typed m:ss / mm:ss / h:mm:ss field beside "Re-record from here" feeding
  the SAME computeCutPlan path as scrubbing — #22's block precision
  inherited automatically, no granularity caveat in the copy.
- **Delivery shape:** one verbatim extraction — reviewCutFromHere's
  cut-application body became the shared `applyReviewCutPlan(plan, T)`
  (zero logic changes; DO/EE/EF/EG/EH pass unmodified) — plus pure
  `computeRedoLastTakePlan` (scenario EK pins it byte-identical to
  computeCutPlan's own last-segment k===0 branch) and pure
  `parseReviewTimestamp` (NOT the caption grammar — that one requires
  fractional seconds).
- **Harness: 156 scenarios / 1122 assertions** (`node test.cjs`; scenario
  prefixes end at EP). EL and EP are real-stitched-save differentials
  proving both new cut paths leave the save flows untouched.
- **#25 CLOSED same day** — owner acceptance PASSED 2026-08-04, all 8
  checklist items, both browsers. Known nit, deliberately deferred and
  not raised by the owner: Enter in the typed-time input doesn't submit
  (click the button); fold in a keydown handler if ever wanted.
- Working pattern held again: Sonnet drafted in scratch and pre-verified
  by applying to scratch COPIES and running the real harness;
  orchestrator review verified the extraction was verbatim (diff
  hunk-by-hunk) and hand-checked the k===0 branch equivalence against
  the real computeCutPlan before presenting; owner approved before any
  repo write.

## Permanent design knowledge (carried forward)

- ● **The seam-offset formula now has FOUR lockstep sites**:
  concatenateWebM / scanSegmentsForStitch / computeCutPlan /
  computeRedoLastTakePlan — `Math.max(lastClusterMaxBlockTime,
  maxClusterTs) + SEAM_GAP_MS` (33ms). Any seam change touches all four;
  DS assertNoOverlap enforces, EK's JSON-equality oracle pins the fourth
  against the third.
- ● **Both browsers' MediaRecorders write UNKNOWN-SIZE clusters** (Chrome
  1-byte 0xFF, Firefox 8-byte all-ones — scenarios N/O/AL). This is why
  #22 needed zero byte-surgery. refineCutToBlock REFUSES known-size
  clusters (scenario-AX asymmetry) and falls back to Rule A.
- ● **The keep-whole promotion is intended behavior**: T in the gap after
  a cluster's last block keeps that whole cluster (cut byte = cluster
  end). DO's expectedBlockCut oracle pins it.
- ● **The dark Screen button has FOUR click meanings** (scenario EI):
  webcam off + no stream → picker; webcam on + no stream → camera-only
  entrance (v1.12); lit → toggle-off; intent-off → re-enable intent.
  Touch toggleSource only with AH/EI in view.
- ● FF153: audio codec in mimeType + no audio track = silent zero-chunk
  recorder (v1.21.2 fix: opus only when audio present; scenario DX). FF
  has no vp9. FF first blob can be ~7.5s late (start-verify grace). FF
  clusters ~7.5s vs Chrome ~1s. FF storage can wedge (watchdogs guard).
- file://-Chrome can't list device names; owner's Chrome has
  showSaveFilePicker on file://; Bluetooth hands-free masquerades as
  interference.
- Watch for **Firefox 154** (~1 week): may fix the upstream opus bug;
  v1.21.2's fix and the watchdogs stay regardless.

## Load-bearing invariants (do not break)

- Seam offsets = previous segment's CONTENT END, four lockstep sites (see
  above). refineCutToBlock's keptEndMs FLOORS at the cluster timestamp
  (DZ pins it) — don't remove the Math.max(0, …).
- `applyReviewCutPlan` is the ONE cut-application path (undo record,
  refinement, discards, pane close, status). Its 'noop'/'startOver'
  handling stays with each CALLER (messages differ by entry point). Its
  `T` is read only on the cutAtByte>0 branch — redoLastTake passes 0
  legitimately; if you ever read T unconditionally, every caller needs a
  real one.
- Refinement is an ENHANCEMENT: try/catch falls back to Rule A's
  byte/time on any failure (EF pins); seam-gap/noop plans never attempt
  the ranged read (EH pins). Never let a refinement error surface.
- `claimFinalize()` makes onstop / stop-watchdog / salvage mutually
  exclusive; finalizeStarted SURVIVES resetUI, resets only in
  startRecording. All salvage paths force stopMode='save'.
- Undo re-record arms the FULL pane chain (restoreSegments) — DO/EE/EK
  pin it; undo of a re-cut restores the PREVIOUS marker exactly.
- confirmDownloadArrived: mark-completed-first, background delete.
- The review-pane preview is the ONE legitimate concatenateWebM caller.
- New reviewState fields go into resetState(). (#25 added none — the
  typed input is read off the DOM at click time; the harness resetState
  DOES reset the two new DOM controls.)

## Gotchas (unchanged ones compressed)

- New vm module state must be `var`; timing consts go in ORIG_TIMINGS AND
  resetState's timer-clearing block. ORIG/resetState also
  capture/restore getDisplayMedia (DY) — mirror for any new navigator
  mock a scenario swaps.
- PowerShell Get-Content/Set-Content mangles this repo's BOM-less LF
  files — Edit tools or bash/sed only. (Applying v1.23 via bash `cp`
  from scratch copies worked cleanly; git's CRLF warnings are benign —
  the object store keeps LF.)
- Grep tool can render `//` as `\` (display artifact) — Read before
  believing a "syntax error".
- Scenarios AL/AM/AN pin literal timestamp/Duration strings; AG is the
  lit-guard case; EI pins the four Screen-click meanings.
- Real-browser behavior is invisible to the harness — owner acceptance
  gates every UI-flow feature. Console-paste diagnostics remain the
  field tool of choice.

## Queue

- **#23 (next): pause → change screens → resume** — scoped in REVIEW #23 (canvas
  compositor makes the video swap pipeline-free; audio-mix reconnection
  is the one new piece; affordance only while paused).
- **#19 (docs/README) + #20 (final full regression)** at stabilization.
  #19 now owes: save-first-then-open caption workflow note; document
  "Redo last take" (the scrub-back-to-redo note is OBSOLETE — #25(a)
  shipped); the Chrome-vs-Firefox save-flow difference is already on
  its list.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block. WebM only.
Don't touch the recording pipeline's byte behavior or the streamed save
flows (differentials enforce). Firefox first. Faculty tone. Delegate
drafting to Sonnet agents; orchestrator reviews EVERYTHING before it
ships. File Edit Rule: agents draft in scratch; orchestrator presents in
full, waits for approval. End with a working page; bump BUILD_LOG and
REVIEW when done.
