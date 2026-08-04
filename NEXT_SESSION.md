# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-08-04 (post-v1.24). Supersedes the post-v1.23
snapshot. Same-day earlier: v1.23 shipped AND #25 closed (owner pass,
all items, both browsers).

## Where things stand

- **v1.24 SHIPPED (#23): pause → change screens → resume.** A "Change
  screen" button between Pause and Stop, visible only while a
  screen-capturing recording is paused (never camera-only — EQ).
  `changeScreenPaused()` acquires the NEW capture FIRST; cancel
  (silent) or failure (one gentle note) is a proven no-op — old screen
  intact, still paused, still resumable (ES/ET). Zero recording-
  pipeline/save-flow changes: EY's end-to-end differential shows a
  paused-swap session's saved bytes === a no-swap session's.
- **#23 CLOSED same day** — owner acceptance PASSED 2026-08-04, both
  browsers (canvas stretch judged acceptable; deliberate swaps never
  tripped a stop). Item 6's no-audio note is Chrome-only in practice:
  Firefox ignores getDisplayMedia audio entirely (upstream Bugzilla
  1541425), so the note's trigger can't occur there — expected. The
  finding spawned **#26** (Firefox system-audio loopback guidance).
- Working pattern held: Sonnet drafted in scratch + pre-verified on
  copies with the real harness; orchestrator review verified the
  ended-listener extraction byte-for-byte, hand-checked the
  audioContext lifecycle, and found 1 hygiene gap (stale
  audioMixDest/screenAudioSourceNodes between recordings — unreachable
  as a bug, but fixed by amendment: both teardown sites now clear them
  atomically with audioContext); owner approved draft+amendment before
  any repo write.
- **Harness: 165 scenarios / 1197 assertions** (`node test.cjs`;
  prefixes end at EY). Harness-side additions: AudioContext source-node
  mock records connect/disconnect; `makeEndedCapableTrack` does real
  listener bookkeeping and models worst-case stop()-fires-'ended';
  screenVideo/cameraVideo exposed read-only via __api.

## Permanent design knowledge (new ● + carried forward)

- ● **The recorder records the COMPOSITOR CANVAS, not the screen
  stream** — that's why #23 was pipeline-free: swapping
  screenVideo.srcObject mid-pause is invisible to MediaRecorder, chunk
  writes, and saves. The draw clock keeps painting while paused.
- ● **A recording's audio track set is FIXED at start** (v1.21.2 opus
  rule): no mix at start → no audio can ever be added mid-recording.
  Swap audio reconnection goes through the SAME live destination node
  (state.audioMixDest); mix teardown is atomic (context + dest + source
  nodes together, both teardown sites).
- ● **The screen 'ended' listener is a tracked (track, handler) pair**
  (wire/unwireScreenEndedListener) — deliberate swap stops can't trip
  it even on a browser that fires 'ended' on script stop(); genuine
  "Stop sharing" still stops the recording. Never re-inline it.
- ● The seam-offset formula has FOUR lockstep sites: concatenateWebM /
  scanSegmentsForStitch / computeCutPlan / computeRedoLastTakePlan
  (EK's oracle pins #4 against #3; DS assertNoOverlap enforces).
- ● The dark Screen button has FOUR click meanings (EI); camera-only
  reachability pinned by AH. changeScreenPaused is deliberately a
  SEPARATE entry point — don't fold it into toggleSource/selectScreen.
- ● Both browsers write UNKNOWN-SIZE clusters (Chrome 1-byte 0xFF, FF
  8-byte all-ones — N/O/AL); refineCutToBlock refuses known-size
  clusters (AX) and falls back to Rule A.
- ● FF153: audio codec in mimeType + no audio track = silent zero-chunk
  recorder (DX pins the fix). FF has no vp9; first blob can be ~7.5s
  late; clusters ~7.5s vs Chrome ~1s; storage can wedge (watchdogs).
- Watch for **Firefox 154** (~days away): may fix the upstream opus
  bug; v1.21.2's fix and the watchdogs stay regardless.

## Load-bearing invariants (do not break)

- Seam offsets = previous segment's CONTENT END, four lockstep sites.
  refineCutToBlock's keptEndMs floors at the cluster timestamp (DZ).
- applyReviewCutPlan is the ONE cut-application path; 'noop'/'startOver'
  stay with each CALLER; its T is read only on the cutAtByte>0 branch.
- changeScreenPaused ORDERING: new capture succeeds BEFORE anything old
  is touched (unwire listener → disconnect audio → stop tracks →
  reassign → rewire → reconnect). ES/ET pin the no-op guarantees; EU
  pins the listener guard; EV pins same-destination reconnection.
- Refinement is an ENHANCEMENT (EF/EH pin fallbacks); never surface a
  refinement error.
- claimFinalize() mutual exclusion; finalizeStarted survives resetUI,
  resets only in startRecording; salvage paths force stopMode='save'.
- Undo re-record arms the FULL pane chain (DO/EE/EK).
- confirmDownloadArrived: mark-completed-first, background delete.
- The review-pane preview is the ONE legitimate concatenateWebM caller.
- New reviewState fields go into resetState(). New state fields go into
  the harness resetState Object.assign AND (if mix-related) the atomic
  teardown sites.

## Gotchas (unchanged ones compressed)

- New vm module state must be `var`; timing consts go in ORIG_TIMINGS
  AND resetState's timer-clearing block; mirror the DY capture/restore
  pattern for any navigator mock a scenario swaps.
- PowerShell Get-Content/Set-Content mangles this repo's BOM-less LF
  files — Edit tools or bash/sed only. Git's CRLF warnings are benign.
- Grep tool can render `//` as `\` (display artifact) — Read before
  believing a "syntax error".
- AL/AM/AN pin literal timestamp/Duration strings; AG lit-guard; EI
  four Screen-click meanings.
- Real-browser behavior is invisible to the harness — owner acceptance
  gates every UI-flow feature. Console-paste diagnostics remain the
  field tool of choice.

## Queue

- **#26 (new, owner-raised): Firefox system-audio loopback guidance** —
  scoped in REVIEW #26. Core fact: Firefox CANNOT capture system audio
  from a web page (upstream Bugzilla 1541425, open since 2019; FF
  silently ignores getDisplayMedia's audio:true — which the app already
  requests, and which lights up automatically if FF ever ships it).
  Shippable scope is guidance only: a Firefox-only no-audio hint
  (placement/wording needs owner input — don't nag every share) + a #19
  guide section for the loopback workaround (Stereo Mix / VB-Audio
  Virtual Cable as the selected mic — the existing mic picker already
  supports this today with zero code; caveats: mic+system needs an
  OS-level mix e.g. VoiceMeeter, echo risk).
- **#19 (docs/README) + #20 (final full regression)** — the feature set
  may now be stabilizing. #19 owes: save-first-then-open caption
  workflow note; document "Redo last take" + typed timestamp + "Change
  screen"; Chrome-vs-Firefox save-flow difference; and #26's loopback
  guide (natural home).
- Roadmap remainder (REVIEW feature map): chapter hotkeys + sidecar
  export, caption VTT/SRT import, mediabunny remux (Cues/MP4) — all
  unscheduled, owner-priority-driven.

## Ground rules (unchanged)

Zero dependencies, single `index.html`, ONE `<script>` block. WebM only.
Don't touch the recording pipeline's byte behavior or the streamed save
flows (differentials enforce). Firefox first. Faculty tone. Delegate
drafting to Sonnet agents; orchestrator reviews EVERYTHING before it
ships. File Edit Rule: agents draft in scratch; orchestrator presents in
full, waits for approval. End with a working page; bump BUILD_LOG and
REVIEW when done.
