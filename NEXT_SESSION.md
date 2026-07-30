# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-30 (post-v1.20). Supersedes the post-v1.18 snapshot.

## Where things stand

- **v1.19 (metadata cut primitive) and v1.20 (Stop & review pane, re-record
  flow, Firefox seam fix) are shipped, committed (`469389a`, `89e5c31`), and
  past the owner's targeted Firefox acceptance** (2026-07-30: full re-record
  cycle — clean cut at the chosen point, stitched output plays smoothly
  through the seam). Not yet pushed to origin at snapshot time — check.
- **#21 is 2 of 3 sessions done.** Session 3 = the remaining v1.20 manual
  acceptance items (4–13, plus a Chrome pass) and whatever they shake out;
  pairs naturally with #20.
- **Harness: 126 scenarios / 812 assertions** (`node test.cjs`; prefixes end
  at DS). Orchestrator review caught 1 defect in the v1.19 draft and 4 in
  the v1.20 draft; owner browser testing caught 2 more the harness cannot
  see (real-browser behavior) — both the review pass AND the owner
  acceptance step are load-bearing.
- **The design in one breath:** truncation is METADATA — a `cutAtByte`
  marker on the session record, enforced ONLY inside `forEachSessionChunk`
  (the single choke point; stored chunks are never rewritten; undo =
  delete the marker). `computeCutPlan` is pure Rule-A math (the cluster
  containing T is dropped). Whole-segment drops use `discarded: true`,
  swept by `deleteDiscardedSessions()` at every confirmed-save/discard site.

## Load-bearing invariant (v1.20 — do not break)

Seam offsets are the previous segment's CONTENT END:
`Math.max(prevScan.lastClusterMaxBlockTime, prevScan.maxClusterTs) + SEAM_GAP_MS`
(33ms), implemented in LOCKSTEP in `concatenateWebM` (oracle + review
preview), `scanSegmentsForStitch` (streamed saves), and `computeCutPlan`.
Never change one without the others — scenario DS's `assertNoOverlap`
re-scans real stitched output and fails if any seam rewinds the timeline.

## Permanent platform knowledge (new ● + carried forward)

- ● **Firefox MediaRecorder emits ~7.5-SECOND clusters** (Chrome: ~1s),
  regardless of the 1s timeslice. This is why the old `maxClusterTs + 1000`
  seam formula overlapped by ~6.5s and killed FF video decode (fixed
  v1.20), and why cut precision is cluster-bound at ~7.5s in FF (queued as
  #22). Test any cluster-assumption code against `syntheticLongClusterWebm`.
- ● Diagnostic: `analyze-webm.cjs` (session scratchpad; rebuildable — loads
  index.html's script in a vm like test.cjs, walks clusters, prints
  ts/contentEnd/block counts/VP8 keyframe dims/overlap flags). Confirmed
  the v1.20 root cause from the owner's broken file in seconds.
- file://-served Chrome can't list mic/camera names; owner's Chrome has
  `showSaveFilePicker` on file://; Bluetooth hands-free masquerades as
  interference (all unchanged from the post-v1.18 snapshot).

## Queue

- **#21 session 3 (next):** v1.20 manual list items 4–13 + Chrome pass;
  fix findings; close #21.
- **#22 block-precision cut** (design brief first): truncate INSIDE the
  final kept cluster at a block boundary — fixes FF's ~7.5s cut precision.
- **#19 (docs/README) + #20 (final regression)** at stabilization.
  Authoring polish stays parked and unversioned.

## Gotchas (new ones ●; older ones from the post-v1.18 snapshot still apply)

- ● Top-level `const`s don't attach to the vm sandbox — expose via the
  `__api` line (`SEAM_GAP_MS`, `reviewState` are there now); function
  declarations attach automatically.
- ● Scenarios AL/AM/AN pin literal timestamp/Duration strings — any seam or
  duration change means recomputing their expected values (they fail loudly).
- ● The review-pane preview is the ONE legitimate `concatenateWebM` caller
  (preview only) — saves must never route through it.
- ● New `reviewState` fields must be added to `resetState()`; tests that
  hand-rig `reviewState` for cut calls must set `scansOk: true`.
- Real-browser behavior (playback, seams, silent unhandled rejections) is
  invisible to the harness — every UI-flow feature needs an owner
  acceptance pass before it counts as done.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block. WebM only.
Don't touch the recording pipeline or the streamed save flows' byte
behavior (differentials enforce it). Firefox first. Faculty tone. File
Edit Rule: agents draft in scratch; orchestrator reviews, presents in
full, and waits for approval. End with a working page; bump BUILD_LOG and
REVIEW when done.
