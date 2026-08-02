# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-08-02 (post-v1.21.2). Supersedes the post-v1.20
snapshot.

## Where things stand

- **Five releases shipped and pushed today** (all committed, origin/main
  current): v1.20.1 (Undo chain-restore blocker + review-handler
  hardening), v1.20.2 (owner-acceptance batch: timer freeze at Stop,
  stale-error clear, instant download-confirm via mark-first/background
  delete, dismissable error banner, caption sidecar hint), v1.21
  (#24 recorder+storage resilience watchdogs), v1.21.1 (start-verify
  grace window + restart-first message), **v1.21.2 (THE root-cause fix
  — see below)**.
- **Harness: 138 scenarios / 940 assertions** (`node test.cjs`; scenario
  prefixes end at DX).
- **#21 is still open on the owner's manual pass.** The owner has a
  consolidated checklist (Part R resilience + F1–F15 Firefox + C1–C13
  Chrome; delivered in-chat 2026-08-02 — the scratchpad copy dies with
  the old session, but BUILD_LOG's Testing section holds every list).
  Almost all of today went to the Firefox saga; the F/C items are mostly
  untested. Every dead-save failure the owner hit today was the v1.21.2
  root cause — with it fixed, the F-list should finally run clean.
  F6 (Undo) order matters: cut → click Undo IMMEDIATELY (it disappears
  by design once re-recording starts) → record → save.

## The Firefox saga in one breath (today's arc, don't relearn it)

Owner reported dead save dialogs + missing recovery banners. Storage-wedge
theory → disproved by owner-run console diagnostics (storage healthy).
Recorder-death theory → confirmed: recorder inactive, ZERO chunks, no
onstop/onerror ever. v1.21 shipped watchdogs (start-verify, stop
watchdog, write-stall, storage watchdogs, salvage paths). Then the owner
reproduced it DETERMINISTICALLY: **Firefox 153 silently records NOTHING
(state stuck 'recording', zero dataavailable, no events) when the
mimeType names opus but the stream has no audio track.** The app
requested `…,opus` unconditionally → every no-mic recording died; every
mic recording worked. "Restart fixed it" was coincidence. v1.21.2 fix:
`audioCodecSuffix = audioStreams.length > 0 ? ',opus' : ''`.

## Permanent platform knowledge (new ● + carried forward)

- ● **FF153: audio codec in mimeType + no audio track = silent zero-chunk
  recorder.** Constructor succeeds, start() succeeds, state claims
  'recording'. Also: FF doesn't support vp9 at all (constructor throws
  NotSupportedError on vp9,opus), so FF always uses the vp8 tier.
- ● **FF MediaRecorder can also legitimately deliver its first non-empty
  blob late** (~7.5s cluster cadence) — hence start-verify's grace window
  (4s + 6s; inactive recorders still abort at 4s; paused never judged).
- ● Firefox storage CAN wedge (Bugzilla qm-shutdown-hangs family) — it
  wasn't today's culprit but the A/B storage watchdogs guard it.
- ● Firefox MediaRecorder emits ~7.5-SECOND clusters (Chrome ~1s) — the
  v1.20 seam-formula lesson; cut precision cluster-bound in FF (→ #22).
- file://-served Chrome can't list mic/camera names; owner's Chrome has
  `showSaveFilePicker` on file://; Bluetooth hands-free masquerades as
  interference (unchanged).

## Load-bearing invariants (do not break)

- Seam offsets = previous segment's CONTENT END:
  `Math.max(lastClusterMaxBlockTime, maxClusterTs) + SEAM_GAP_MS` (33ms),
  in LOCKSTEP in `concatenateWebM` / `scanSegmentsForStitch` /
  `computeCutPlan`; scenario DS's `assertNoOverlap` enforces.
- `claimFinalize()` (sync check-and-set) makes onstop / stop-watchdog /
  salvage mutually exclusive. `finalizeStarted` deliberately SURVIVES
  resetUI and resets only in startRecording — a late onstop after a
  watchdog salvage must stay a no-op. Don't "clean it up" into resetUI.
- onstop clears the stop watchdog only AFTER winning the claim (a hung
  final chunk-write must leave the watchdog armed).
- All salvage paths force `stopMode='save'` — a dead recorder is never a
  review moment.
- Undo re-record arms the FULL pane chain (`restoreSegments`), same model
  as Back-to-recorder — scenario DO pins it (v1.20.1 fixed the stale
  `priorSegmentsBefore` data-loss bug; don't reintroduce it).
- confirmDownloadArrived: mark-completed-first, background the physical
  delete; a marking failure restores the queue (retry stays live).

## Gotchas (new ● + still-true old ones)

- ● New module state for the vm must be `var` (top-level let/const don't
  attach to the sandbox). Timing consts (START_VERIFY_MS etc.) are
  captured in test.cjs `ORIG_TIMINGS` and restored per scenario;
  resetState also clears pending watchdog timers (real timers leak
  across scenarios otherwise) — extend BOTH when adding any.
- ● PowerShell Get-Content/Set-Content rewrites mangle this repo's
  BOM-less LF files — use Edit tools or bash/sed only.
- ● Grep tool output can render `//` comment leaders as `\` (display
  artifact) — verify with Read before believing a "syntax error".
- Scenarios AL/AM/AN pin literal timestamp/Duration strings — recompute
  if seam/duration math ever changes (it didn't today).
- The review-pane preview is the ONE legitimate `concatenateWebM` caller.
- New `reviewState` fields must go into `resetState()`.
- Real-browser behavior is invisible to the harness — owner acceptance
  gates every UI-flow feature. Console-paste diagnostics (alert + copy())
  proved extremely effective for field debugging — reuse that pattern.

## Queue

- **#21 session 3 (next): the owner's manual pass**, now on a build where
  mic-less Firefox recordings actually work: Part R (R1 healthy-cycle;
  R2 already witnessed live), F1–F15 Firefox first, then C1–C13 Chrome.
  Fix findings; close #21.
- **#22 block-precision cut** (design brief first — Fable designs,
  truncate INSIDE the final kept cluster; scenario-AX asymmetry applies).
- **#23 pause → change screens → resume** (scoped in REVIEW #23: canvas
  compositor makes the video swap pipeline-free; audio-mix reconnection
  is the one new piece; show the affordance only while paused).
- **#19 (docs/README) + #20 (final full regression)** at stabilization.
- Watch for **Firefox 154** (~2 weeks): may fix the upstream opus bug;
  v1.21.2's fix and the watchdogs stay regardless.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block. WebM only.
Don't touch the recording pipeline's byte behavior or the streamed save
flows (differentials enforce). Firefox first. Faculty tone. Delegate
drafting to Sonnet agents; orchestrator reviews EVERYTHING before it
ships (today: 5 defects caught in the v1.21 draft alone, incl. a
data-loss delete — the review pass stays load-bearing). File Edit Rule:
agents draft in scratch; orchestrator presents in full, waits for
approval. End with a working page; bump BUILD_LOG and REVIEW when done.
