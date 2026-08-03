# DidaRec — Fable 5 Code Review (2026-07-20)

*Review of v1.5 (`index.html`, 2,154 lines) by the Fable session that ran the original
feature research and prior-art recon. Line numbers reference the v1.5 file; re-locate by
function name if the file has drifted. Sharpest findings were verified by extracting the
script and testing the relevant code paths in Node.*

**Verdict:** Sound architecture, one excellent judgment call (IndexedDB over File System
Access API for chunk durability — FSA's `createWritable()` swap file is not committed
until `close()`, so the build log's rationale is correct and better than the original
plan). Three genuine data-loss bugs exist, all in the SAVE flow, not the recording
pipeline. Fix P0 before anyone records something they care about.

---

## P0 — Data-loss bugs (fix first, one session)

### 1. Canceling the save dialog permanently deletes the recording — ✓ FIXED v1.6
`saveFile()` (~line 1836) catches AbortError when the user cancels the picker, shows
"Save cancelled — recording preserved", and RETURNS NORMALLY. Every caller then deletes
the session anyway:

- `finalizeRecording()` ~line 1758: `await saveFile(currentBlob); await deleteSession(state.sessionId);`
- `stitchAndSave()` ~lines 1799–1802: deletes all prior segments + current after saveFile
- `recoverRecording()` ~lines 1969–1972: deletes all sessions after saveFile

**Consequence:** cancel the picker → recording destroyed while the UI claims it's safe.

**Fix:** `saveFile()` returns `true` (saved) / `false` (cancelled). Callers delete
sessions only on `true`. On `false`, keep sessions and tell the user how to get back to
them (the recovery banner already handles reload).

### 2. Multi-crash recovery failure path deletes unsaved segments — ✓ FIXED v1.6
`recoverRecording()` ~line 1961: if `concatenateWebM` throws, the fallback saves ONLY
the most recent segment (`finalBlob = segmentBlobs[segmentBlobs.length - 1]`) — then the
cleanup loop deletes ALL sessions, including earlier segments that were never saved.

**Fix:** reuse the `stitchAndSave()` fallback pattern (save each segment as a separate
numbered file); delete only sessions whose data was actually written.

### 3. Chunk-write failures are silent — ✓ FIXED v1.6
`recorder.ondataavailable` ~lines 1627–1639: `addChunk` failures are caught and
`console.error`'d; recording continues while chunks silently drop. Most likely trigger:
`QuotaExceededError` when IndexedDB storage quota fills during a long recording.
Missing chunks corrupt the WebM stream from that point.

**Fix:** on chunk-write failure, surface a visible error, stop the recorder gracefully,
and route to the normal finalize path so everything recorded so far is preserved.
Detect `QuotaExceededError` specifically and say "storage full" in plain language.
Optional: check `navigator.storage.estimate()` at start and warn if low.

---

## P1 — Must address before real classroom use

### 4. Background-tab freeze (TEST FIRST — likely the biggest real-world risk) — ✓ FIXED v1.6 (Worker-driven draw clock; manual hidden-tab test added to BUILD_LOG)
Compositing runs on `requestAnimationFrame` (`startCompositing()` ~line 986). Chrome
pauses rAF in hidden tabs. The NORMAL faculty workflow — start recording, switch to
PowerPoint full-screen — may hide the tab, stop the draw loop, and record a frozen
frame with live audio. Easily masked in testing when the tab stays visible on a second
monitor.

**Test:** record; fully cover/minimize the tab for 60s while on-screen content moves;
inspect the file.

**Fix if frozen:** drive the draw loop from a Web Worker timer (workers are not
visibility-throttled): worker `setInterval(33ms)` → `postMessage` → draw. Keep rAF when
visible if desired; switch clocks on `visibilitychange`.

### 5. Every save materializes the whole recording in RAM — ✓ FIXED v1.11 for single-segment saves, ✓ FIXED v1.13 for multi-segment stitching (streamed two-pass save: per-chunk cursor pulls → bounded-carry index scan with byte-identical output to the buffered `makeSeekable`/`concatenateWebM` → streamed FSA writes on Chrome / reference-composed download Blob on Firefox; any indexing doubt still saves un-indexed (single segment) or bails to streamed separate-parts saves with an in-app banner (multi-segment, replacing the old blocking `confirm()` — see #10); the page-load recovery banner cursor-sums instead of chunk-`getAll`; save progress shown. BUILD_LOG Known Limitation #1 is closed — `concatenateWebM` stays in the file only as the differential-test oracle, unreachable from any save flow.)
`getSessionChunks()` ~line 552 uses `getAll()` — every chunk ArrayBuffer loads at once.
At 2.5 Mbps, a 3-hour recording ≈ 3.4 GB in memory AT SAVE TIME — the tab can crash at
the finish line, undoing the crash-resilience story. This affects the normal save path,
not just stitching (build log limitation #1 understates it).

**Fix:** iterate an IndexedDB cursor over the session's chunks and `write()` each to the
FileSystemWritableFileStream incrementally; never hold more than one chunk. Stitching
can stream similarly (first segment raw; later segments need only the cluster scan,
which requires the buffer — consider per-segment streaming with bounded memory, or
document a practical segment-size ceiling).

### 6. No seeking (missing Cues) hurts more than "known limitation" suggests — ✓ FIXED v1.8 (zero-dependency `makeSeekable()` in `saveFile`: save-time Duration + Cues remux; Option A chosen over mediabunny to stay zero-dependency; any indexing failure falls back to saving the un-indexed file)
Students scrub lecture video constantly; MediaRecorder WebM without Cues seeks slowly/
imprecisely. Promote to next-major-feature: the planned mediabunny remux-on-save adds
Cues AND optional MP4 export in one stroke. (Keep the recording pipeline as-is; remux
at save time only. Do NOT switch recording to non-fragmented MP4 — see build log.)

---

## P2 — Robustness and UX

7. — ✓ FIXED v1.12 (dropped the load-time temp `getUserMedia`; `enumerateDevices()`
   enumerates directly; `captureCamera`/`captureMic` re-enumerate on grant to upgrade
   labels; a blank re-enumerate never overwrites a known-good label) **Permission
   prompt on page load** (`enumerateDevices()` ~line 716 calls
   `getUserMedia({audio:true,video:true})` on load). Privacy-minded faculty see a
   camera+mic prompt before touching anything. Enumerate without labels initially;
   request permission lazily on first toggle/use, then re-enumerate for labels.
   (Elevated by the v1.9 Firefox-first pass: Firefox doesn't persist mic/camera grants
   by default, so this prompt shows on every load in the now-primary browser.)
   *(Camera-only discoverability — flagged as an open item in the Firefox-first pass —
   resolved in the same v1.12 session: the at-least-one-source guard now explains
   itself via `showError()` instead of failing silently, and entering camera-only via
   Screen-off auto-starts the camera preview. Full diagnosis in BUILD_LOG v1.12.)*
8. — ✓ FIXED v1.8 (byte-scan now requires a Timestamp element `0xE7` as the first child of a candidate Cluster; done alongside the Cues writer, which builds the seek index from these boundaries) **EBML byte-scan validation is weaker than its comment claims** (~lines 1263–1287).
   The comment says a Timestamp element should follow "at a plausible position" but the
   code only checks that a size VINT parses (almost any byte ≥ 0x01 passes). Add the
   check: byte at `sizeStart + candidateSize.length` should be `0xE7`. Cuts
   false-positive cluster boundaries in compressed data.
9. — ✓ FIXED v1.8.1 (byte-pattern check replaces the numeric comparison; this stopped being "currently harmless" the moment Firefox entered the picture — Firefox writes 8-byte unknown-size markers on every cluster, which made v1.8 stamp first-cluster-only Durations into paused/resumed recordings) **8-byte unknown-size VINT evades detection (verified by test).** In
   `ebmlReadVarInt` (~line 1159), for width 8 both the parsed all-ones value and
   `maxKnown[7]` round to the same float (72057594037927940), so `value > maxKnown` is
   false. Currently harmless: Chrome writes 1-byte unknown markers for clusters (works)
   and the Segment case is rescued by `safeEnd` clamping. Add a comment + explicit
   byte-pattern check (`width === 8 && all bytes after marker === 0xFF`) so a future
   refactor doesn't trip on it.
10. — ✓ FIXED v1.13 (the blocking `confirm()` in `stitchAndSave`'s
    stitch-failure fallback is replaced by an in-app banner — `#stitchFallback`,
    styled off the existing `.download-confirm` class, same visual language as
    the recovery banner and download-confirm bar — with "Save as separate
    files" / "Not now — keep them stored here" buttons driving
    `saveSegmentsAsParts` / `stitchFallbackKeep`. Both the pass-1 bail path and
    genuine write-time exceptions route to the same banner; the harness asserts
    the buttons drive the same code paths the `confirm()` branches used to,
    and that the sandbox's absence of a global `confirm` — reaching it would
    throw — is never exercised.) **`confirm()` fallback in `stitchAndSave`**
    (~line 1809 in the reviewed v1.5 file; the function has moved since):
    replace with in-app buttons (matches faculty-audience convention; blocking
    dialogs are hostile UX and break automation/testing).
11. **Dead code / housekeeping:** `getIncompleteSession()` (~line 538) is unused now.
    Zero-chunk incomplete sessions (created if `startRecording` fails after
    `createSession`) accumulate forever — sweep them in `cleanupCompleted()`.
12. **Two tabs of the app fight over IndexedDB.** A second tab shows the recovery
    banner for a recording in progress in the first and can discard it. Use the Web
    Locks API or a heartbeat timestamp to detect "recording live in another tab" and
    warn.
13. **Accessibility of the app itself:** PiP is mouse-only (add arrow-key nudging when
    focused), verify text-dim contrast (#8892a4 on #1a1a2e) against WCAG AA, add
    visible focus styles. An education tool should model the standard it serves.

---

## Firefox-first pass (2026-07-23)

### 14. Firefox cancel/failed-save deletes the recording (download fallback) — P0 — ✓ FIXED v1.9
Firefox lacks `showSaveFilePicker`, so `saveFile()` uses the `a.click()` download
fallback and returns `true` unconditionally; callers then `deleteSession`. A cancelled
"Save As" or a failed download loses the recording — the v1.6 P0 #1 guarantee doesn't
hold in Firefox, now the primary browser. Fix: the download path must not count as a
confirmed save; keep the session recoverable and surface a "downloaded — recover if it
didn't land" affordance; decide the lingering-session sweep policy. *(v1.9: tri-state
`saveFile` + download-confirmation bar; sweep policy = immediate affordance with
recovery-banner backstop, chosen by the owner.)*

**Sweep findings (v1.9 pass — all verified clean in code; real-Firefox acceptance on
the owner's manual list):** codec → vp8,opus via existing fallback (clean); system
audio absent in Firefox screen capture → guarded, mic-only (documented, BUILD_LOG
limitation #7); worker draw clock browser-agnostic (clean); IndexedDB ephemeral in
private windows (documented, limitation #8); picker cancel already handled (clean).

*(Follow-up polish — ✓ FIXED v1.12.2: a 2nd unresolved download used to overwrite
the 1st's confirm bar; now it appends with ID dedupe and the bar counts all covered
files. Was safe — recovery-banner backstop — just dishonest about coverage.)*

---

## Mic device selection (2026-07-28 – 2026-07-29)

### 15. Mic dropdown never showed real names; Chrome recorded a Bluetooth headset instead of the mic — P0 — ✓ FIXED v1.14
Found during v1.13's Chrome acceptance pass (2026-07-28): the recording saved fine,
but picked up no voice, only interference-like sounds. Root cause was four-layered:
no pre-recording mic grant path (the only `getUserMedia` lived inside `startRecording`
via `captureMic`, so the v1.12 label upgrade landed exactly as `updateToggleUI()`
disabled the select); pre-grant placeholder options carried `value=""`, colliding
with the Default option, so selecting one never reached a deviceId constraint; an
owner-run diagnostic (Chrome 150, file:// scheme) then found `enumerateDevices()`
returns blank ids AND labels at every stage, including during a live granted stream
— file:// origins never persist a `getUserMedia` grant, so an in-app device list is
structurally impossible there and Chrome's own per-capture permission pop-up is the
only thing that ever worked. With selection inert, Chrome fell back to a Bluetooth
headset's hands-free profile (8–16 kHz telephony audio) — the actual source of the
"interference"; Firefox happened to default to the real mic, which is why Firefox
worked all along.

**Fix (v1.14):** `primeMicLabels()` early grant path (toggle-ON forced, `#micSelect`
mousedown/focus passive, all gesture-gated); blank-id placeholder options removed; an
anonymized-re-enumeration guard extends the v1.12 "blank never overwrites good" rule
to ids; a persistent `micEnumAnonymized` verdict stops any prime path from
re-prompting once a completed grant+enumerate has proven the environment can't
deliver names, self-clearing on any real-option rebuild; an honest Default-option
placeholder (`Chosen in the browser pop-up` / `Microphone: <granted track label>`);
`captureMic` surfaces the granted track's own label as a UI-only side effect.
Recording pipeline untouched — enumeration/selection UI only. Real acceptance
(owner, both browsers, 2026-07-29): Chrome — zero prompts from the dropdown/toggle
(only the platform's own record-start prompt remains, which doubles as the mic
picker in this environment), correct "Microphone: <device>" label shown, real voice
on playback; Firefox — full dropdown works, no regressions.

## v1.14 follow-ups (2026-07-29)

### 16. Camera dropdown never shows the webcam's name in file:// Chrome; mic toggle defaulted on — P2 — ✓ FIXED v1.15 (owner-accepted 2026-07-29)
Owner-requested at v1.14 close-out. Same anonymized file:// environment as the mic:
the camera dropdown could only ever hold "Default camera" there, even with the
webcam on and granted, because v1.14 built the honest-label machinery for the mic
only. And the mic toggle defaulting ON no longer matched the webcam's OFF default.

**Fix (v1.15):** `applyMicDefaultText` generalized into a shared
`applyDeviceDefaultText(type)`; `captureCamera` surfaces the granted video track's
own label (`Camera: <label>`) via `state.lastCameraLabel`; a separate persistent
`camEnumAnonymized` verdict (mic and camera are granted separately), set/cleared in
`captureCamera` itself — no priming needed, the Webcam toggle's preview path already
grants early. Mic toggle now defaults OFF at load; toggle-ON is the natural first
priming gesture, zero-prompts-at-load still holds, v1.14 verdict behavior unchanged.
Recording pipeline untouched. Harness 74 scenarios / 416 assertions (new BL–BR).
Owner-accepted 2026-07-29, both browsers, combined with v1.16.

## Record-time mic prompt (2026-07-29)

### 17. Mic permission pop-up fired at the Record click, stalling the start of every recording — P1 — ✓ FIXED v1.16 (owner-accepted 2026-07-29)
Owner-reported during the v1.15 browser pass. The mic was only ever acquired
inside `startRecording` → `captureMic`, so in environments without persisted
grants (file:// Chrome always; Firefox without a remembered grant) the pop-up
fired at the Record click — recording doesn't begin until the grant resolves, so
a user who starts talking immediately loses their opening words to the pop-up.

**Fix (v1.16):** the mic mirrors the webcam's preview-hold pattern. Toggle-ON
acquires and HOLDS the stream (`acquireMicHold`/`state.heldMicStream`) — the
prompt moves to setup time, where in file:// Chrome it doubles as the device
picker; `captureMic` reuses the live, selection-matching hold at record with
zero getUserMedia calls, falling back to fresh acquire for dead tracks or a
changed selection; recording stop preserves the hold while the toggle stays on
(`releaseMicRecordingRef`, which also promotes a mid-recording fallback stream
into the new hold); denied/failed grants revert the toggle with copy matched to
the actual failure; `primeMicLabels` and the passive prime are removed, and
`micEnumAnonymized` now governs only the dropdown's honest text. Orchestrator
review caught and fixed a stale-selection race (hold's device id is snapshotted
before the grant `await`) and permission-blaming copy on device failures.
Recording pipeline untouched. Harness 86 scenarios / 472 assertions (new BS–CD;
ten v1.14-era scenarios deliberately rewritten for the new design). Mic now goes
hot at toggle-ON (browser indicator shows pre-recording), matching the camera.
Owner-accepted 2026-07-29, both browsers. During acceptance the owner reported
Chrome's gray download-confirm bar missing after Stop & save — resolved as
platform, not app: their Chrome now exposes FSA on file:// (see BUILD_LOG v1.16
field note), so saves take the verified picker path that never needed the bar.

## Caption editor: Tier 1 accessibility work begins (2026-07-29)

### 18. Caption editor with VTT/SRT import/export — Tier 1, highest-value open item — editor surface shipped v1.18

Foundation (v1.17: pure parse/format/serialize logic) and the editor UI
(v1.18: the open-a-file editor model — open a `.webm`, edit cues against
playback with live caption preview, export a `.vtt`/`.srt` sidecar) are both
now shipped. v1.18 added: mode switching (a "Caption editor" button that
hides the recorder UI and shows the editor pane, refused with plain-language
copy while a recording is in progress); open video (file picker + drag-and-
drop) and import captions (`.vtt`/`.srt`, replace-confirmation banner over a
non-empty list, partial-import messaging); a cue list (add/delete/edit
start/end/text, sorted by start, seek-on-click, active-cue highlight during
playback) built on small testable functions that never touch the DOM
directly; a live `<track>` preview regenerated from the same `serializeVTT`
the export path uses; IndexedDB-backed draft autosave (`DB_VERSION` 2, new
`captions` store, guarded upgrade that leaves `sessions`/`chunks` untouched)
with a restore-or-start-fresh banner (never a blocking `confirm()`); and
export via the same FSA-picker-or-download fork `saveFile()` uses, naming the
sidecar after the video (`lecture.webm` → `lecture.vtt`/`.srt`) and never
deleting the draft on export.

**v1.17 foundation:** `parseCaptionTimestamp`/`formatCaptionTimestamp` (HH:MM:SS.mmm
and MM:SS.mmm, `.`/`,` separators, correct ms-rounding carry); `parseVTT`/`parseSRT`
(BOM/CRLF-tolerant, one bad cue never aborts the file — `skipped` counts malformed
blocks; VTT keeps cue-settings verbatim where the surveyed prior art discards them;
VTT prologue NOTE/STYLE/REGION preserved for round-trip); `detectCaptionFormat`;
`serializeVTT`/`serializeSRT` (SRT renumbers on export, ids never reused).
Orchestrator review caught three tolerance gaps in the v1.17 first draft
(multi-line WEBVTT header blocks, whitespace-only separator lines, one-digit
hours) — fixed and test-locked.

An orchestrator review pass caught eight defects in the v1.18 first draft
before ship, headlined by a timeupdate handler that was full-rebuilding the
cue list on every tick (destroying in-progress, uncommitted caption text
mid-typing during the core transcribe-while-playing workflow), missing
end>start validation on cue-time edits, and a `TextTrack.mode` no-op that
meant the live preview had no guaranteed way to actually turn captions on.
All eight fixed and test-locked (one — the `TextTrack` fix — is a manual-only
acceptance check; the harness has no `TextTrack` object to assert against).
Harness now 115 scenarios / 649 assertions (CQ–CZ then DA–DH), all
pre-existing assertions unchanged.

**Still open (v1.19 remainder, unchanged scope from the feature map):**
keyboard shortcuts, split/merge cues, and chapter-marker hotkeys. v1.18
itself passed the owner's initial acceptance pass (2026-07-29); the full
regression re-run is deferred to the final-build pass (#20).

**Owner decision (2026-07-29): the caption editor STAYS.** The scrap/freeze
question was evaluated (from-scratch authoring is cumbersome; the primary
workflow is reframed as import-and-correct) and resolved KEEP — partly
because the editor's video-playback/scrub surface is half the UI for the
newly prioritized re-record-from-timestamp feature (#21). The v1.19
authoring polish remains queued but is no longer next; #21 is.

## User documentation (queued 2026-07-29)

### 19. End-user instructions + README refresh — queued for when the feature set stabilizes
Owner-requested (2026-07-29): once the remaining pieces land (or are
explicitly descoped — the caption editor's fate is under evaluation), write
the user-facing documentation. Two deliverables:

1. **README refresh** — it has drifted badly: still says "Works in Chrome and
   Edge on Windows" and "File System Access API required" (Firefox has been
   the PRIMARY browser since v1.9, with the anchor-download fallback); the
   feature list predates pause/resume, recording-quality settings, mic noise
   suppression, honest device labels, and the entire caption editor; the
   Usage section still contains a `[your-github-pages-url]` placeholder.
2. **Faculty-facing usage guide** — plain-language instructions for the
   actual audience (non-technical faculty): recording basics (Select Screen,
   source toggles, quality), pause/resume, what crash recovery looks like and
   what to click, Continue Recording, how saving differs by browser (save
   dialog vs. download + confirm bar), captions (the import → fix → export
   sidecar workflow, if the editor is kept), and the file:// Chrome
   device-name caveat in user terms. Faculty tone throughout: what to click,
   never how it works. Decide placement when written: README section,
   separate guide file, and/or a lightweight in-app help affordance.

Not started — deliberately last in the queue so it documents the final shape
instead of chasing a moving one.

Also owed from the owner's 2026-08-03 #21 pass: the caption-editor workflow
must state that a recording is **saved first, then opened** in the editor
(it edits saved files, not the in-progress session); and if #25(a) hasn't
shipped, explain that re-doing a just-recorded take means scrubbing back to
that timestamp in Stop & review.

### 21. Re-record from a timestamp ("take-based recording") — owner-prioritized (2026-07-29), CLOSED 2026-08-03
Owner's ask: pause/stop a recording, review it, pick a timestamp, and
re-record from that point — correcting a big mistake without losing the
whole effort. This is the Tier 2 "take-based recording" the feature map
already called half-built, now concretely scoped. Every hard piece exists:
the v1.13 streamed index scanner locates cluster timestamps/byte offsets
(truncation = tail-cut at the last cluster boundary <= T; tail cuts have no
keyframe problem), Continue Recording provides the append-new-segment-and-
stitch-at-save flow, and the v1.18 editor's video player provides the
review/scrub/pick-a-timestamp surface.

Honest constraints, agreed with the owner up front: cut precision ~1s
(cluster granularity, not frame-exact — frame-exact would need decode/
re-encode, out of scope); reviewing the unsaved recording assembles it in
memory (Blob + makeSeekable for scrubbing) — fine for typical soon-after-
the-mistake use, documented ceiling for very long recordings, MediaSource
streaming playback is the eventual fix; the re-record seam behaves like
today's crash-stitch seams (possible brief black frame, known limitation
#5's territory). Design decision for the brief: keep the discarded tail
recoverable until final save (soft-delete), which is also the doorway to
full multi-take support.

EBML byte-surgery on stored recordings — Fable designs and reviews closely,
Sonnet executes (per the standing streaming-stitch-class note). Estimated
three sessions: (1) truncation primitive + differential harness tests on
synthetic WebM; (2) review-player + "Re-record from here" flow; (3)
integration + acceptance. The LIVE recording pipeline stays untouched —
truncation operates on stored chunks while the recorder is stopped.

**Design (signed off 2026-07-30) — truncation is metadata, not byte-surgery.**
Recon showed the pass-2 save sinks already slice chunks mid-ArrayBuffer at
plan-range boundaries, and every chunk consumer flows through
`forEachSessionChunk`. So the cut is a `cutAtByte` marker on the session
record (the sessions store is schema-less per-record; no DB upgrade),
enforced inside `forEachSessionChunk` — scan pass, save sinks, stitch,
recovery, and preview all inherit the cut at that single choke point, and
stored chunks are never rewritten. Soft-delete falls out of the design: the
tail bytes are untouched until the session is deleted at final save, and
undo = delete the marker. Later segments dropped by a cut get
`discarded: true` (whole-session soft-delete, cleaned up at the same
trigger points as their siblings). Cut-point math is a pure function
`computeCutPlan(segmentScans, T) -> { segIndex, cutAtByte, keptMs }` using
the stitcher's `maxClusterTs + 1000` seam formula, so the preview timeline
and the cut byte derive from the same math and cannot drift.

**UI (signed off):** a new "Stop & review" button beside "Stop & save"
(the existing save path stays untouched); a dedicated slim review pane
built on the v1.18 mode-switch pattern with its own `<video>` (NOT
`#captionVideo` — the caption editor's player is File-only and entangled
with captionEditorState); preview assembly = chunks -> Blob
(`concatenateWebM` if multi-segment) -> `makeSeekable`, with a size-guard
message for very long recordings; buttons: Re-record from here (T) /
Save as is / Discard recording / Back to recorder. After a cut, the app
returns to the existing Continue-Recording armed state with an "Undo
re-record" affordance shown until the next recording starts (tail bytes
still survive to final save; no restore UI after recording resumes).

**Edges:** T before the first cluster -> offer start-over, never a
zero-cluster cut; T at/past the end -> no-op with a message; a boundary
cut in a non-final chain segment leaves a COMPLETE final cluster (the
scenario-AX bail concerns incomplete known-size clusters and is not
triggered); recovery-banner byte stats may overstate for cut sessions
(markers not read by sessionChunkStats — cosmetic, accepted).

**Tests (session 1 is mostly this):** differential — saving a cut session
must byte-equal the buffered oracle (`slice(0, cutAtByte)` ->
`makeSeekable`; cut chains vs `concatenateWebM` of sliced buffers) across
all synthetic fixtures (Chrome-shaped, Firefox 8-byte markers, audio-only)
× the existing chunk-split strategies, plus `computeCutPlan` unit coverage
of every edge above. Session split unchanged: (1) cut plan + choke-point
enforcement + differential tests; (2) review pane + flow; (3) integration
+ acceptance, Firefox first.

**Session 1 SHIPPED (2026-07-30, v1.19):** `computeCutPlan` + choke-point
enforcement in `forEachSessionChunk` + `setSessionCut`/`clearSessionCut` +
differential scenarios DI–DL landed; harness at 119 scenarios / 722
assertions. Orchestrator review caught 1 draft defect (an `isFinite(null)`
marker guard that would have turned a corrupt null marker into an empty
save — now typeof-guarded and test-pinned). Remaining: sessions 2–3.

**Session 2 SHIPPED (2026-07-30, v1.20):** Stop & review + review pane +
Rule-A cut application with exact undo + discarded-session lifecycle +
save-as-is. Orchestrator review caught 4 draft defects; owner Firefox
testing surfaced two more, both fixed same-day: silent dead-click
hardening (scansOk gate + try/catch, scenario DR) and the v1.13 seam
formula overlapping Firefox's ~7.5-second clusters (content-end offsets +
SEAM_GAP_MS, scenario DS — also fixes crash-stitch seams and closes
BUILD_LOG known limitation #4). Harness at 126 scenarios / 812 assertions.
Owner Firefox re-test PASSED (2026-07-30): clean cut at the chosen point,
stitched output plays smoothly through the seam. Firefox cut precision is
cluster-bound (~7.5s there) — queued as #22. Remaining: session 3 —
integration + the rest of the v1.20 manual acceptance list (items 4–13,
plus Chrome), which pairs with #20.

**Session 3 started (2026-07-30, v1.20.1):** a pre-acceptance code audit of
manual items 4–13 + the Chrome-divergence surface (Sonnet audit,
orchestrator-verified) found 1 blocker — Undo re-record restored the stale
pre-review `priorSegments`, silently dropping the just-reviewed segment
from the next save; scenario DO had test-locked the wrong semantics via a
sentinel — and 1 hardening gap (`reviewSaveAsIs` / `reviewDiscardConfirmed`
/ `undoReRecord` were unguarded, the same silent-dead-click class v1.20's
Firefox pass exposed in `reviewCutFromHere`). Both fixed and test-pinned
(DO corrected, DT added; harness 127 scenarios / 831 assertions). Items
5–13 + Chrome branches audited clean in code. Still owed: the owner's
real-browser pass of items 4–13, Firefox first, then the full Chrome pass.

**v1.20.2 (2026-08-02):** the owner's pass of the accumulated v1.18-era
lists surfaced 4 bugs, all fixed same-day (timer ran through the save;
stale errors survived Stop; "It's there — all set" froze 5–10s on chunk
deletion; error banner undismissable — see BUILD_LOG). The reported
"Stop & save dead after the recording-guard error" did NOT reproduce in
code (new end-to-end scenario DU pins the sequence); the timer+stale-banner
combination likely explains it — owner re-test with console open owed.
Harness 128 scenarios / 855 assertions. Also from that pass: pause-and-
switch-screens queued as #23; owner confirmed captions stay sidecar-only
(no burn-in) and a UI hint now says so.

**CLOSED (2026-08-03): the owner's full acceptance pass PASSED** on build
v1.21.2 — Part R (R1–R3 resilience), F1–F15 (Firefox), C1–C13 (Chrome),
every item. Notes from the pass, all handled: Chrome's F3 variant (save
succeeds with no "all set" bar) confirmed as designed behavior — the
confirm bar exists only for Firefox's unverifiable anchor-download path,
Chrome's picker write is programmatically confirmed and retires the
session directly; take-redo friction + typed-timestamp ideas queued as
#25; two user-guide notes added to #19; one cosmetic finding (Screen
toggle lit with no screen selected) fixed same-day as v1.21.3.

### 22. Block-precision re-record cut (queued 2026-07-30)

Firefox's ~7.5s clusters make Rule-A's cluster-boundary cut precision ~7.5s
there (Chrome: ~1s). Fix: truncate INSIDE the final kept cluster at the last
block boundary <= T. The kept cluster is the output's final cluster, so an
unknown-size cluster needs no size rewrite; a known-size one needs its size
field rewritten (or converted to unknown-size) — and the truncated-known-size
asymmetry scenario AX pins must be respected. Differential harness coverage
mandatory. Design brief first; Fable designs/reviews, Sonnet executes.

**Design (signed off 2026-08-03) — refinement is still pure metadata; no
byte-surgery anywhere.** Key recon fact: BOTH browsers' MediaRecorders write
unknown-size clusters (Chrome 1-byte 0xFF, Firefox 8-byte all-ones — pinned
by scenarios N/O/AL), so a cluster truncated at a block boundary needs no
size rewrite: it ends at EOF (lone/final) or at the next cluster (chain) —
the exact shape every crash tail already has, except cleaner (block-aligned,
not mid-block). The AX asymmetry is respected by construction: refinement
applies ONLY to unknown-size clusters; known-size falls back to Rule A
(defensive only — the app never records known-size clusters). Mechanics:
computeCutPlan runs unchanged and identifies the dropped cluster; a ranged
read (`readSessionByteRange`, built on forEachSessionChunk so re-cuts inherit
enforcement) buffers that one cluster (~2–3 MB worst case); a new pure
function `refineCutToBlock(clusterBytes, clusterTs, localT)` walks the
cluster's children with byte offsets — skip Timecode, cut at the FIRST
SimpleBlock with clusterTs+relTs > localT (positional first-exceed: every
kept block <= T even with interleave), any other child type before the cut
point → null → Rule A. Three shapes fall out: mid-cluster cut (~33ms
precision), keep-whole (fixes Rule A's intra-segment-gap over-drop for
free), drop-whole (= null = Rule A byte-identical). keptEndMs = max kept
block ts, which IS the truncated cluster's re-scanned
lastClusterMaxBlockTime, so the seam formula stays in lockstep
automatically. Undo, cutAtMs bookkeeping, and every consumer inherit
through the existing choke point untouched. #25(b)'s typed timestamp will
feed the same path. Differential tests same oracle as v1.19
(slice(0,cutAtByte) -> makeSeekable; chains vs concatenateWebM), new
multi-block fixtures (interleaved audio, negative relTs, both size-marker
shapes, a known-size cluster that must REFUSE refinement), DS assertNoOverlap
extended. Sessions: (1) primitive + fixtures + differential tests; (2) wire
into reviewCutFromHere + owner Firefox acceptance.

**Session 1 SHIPPED (2026-08-03, v1.22):** `refineCutToBlock` +
`readSessionByteRange` + computeCutPlan's `segOffsetMs`/`clusterIndex`
fields + scenarios DZ–ED (unit edges incl. the keptEndMs floor, ranged-read
coverage, and the mandatory single-segment and 2-segment-chain
differentials, both marker shapes, both sinks). Harness 144 scenarios /
999 assertions. Orchestrator review caught 1 draft defect (keptEndMs could
sit below the cluster timestamp when every kept relTs is negative,
drifting the bookkeeping below the post-cut re-scan's
lastClusterMaxBlockTime — now floored and test-pinned in DZ). Remaining:
session 2 — wire-in + owner acceptance.

**Session 2 SHIPPED (2026-08-03, v1.22.1) — #22 CODE-COMPLETE.**
`reviewCutFromHere` refines the cut between computeCutPlan and
setSessionCut (ranged read → refineCutToBlock → refined byte/keptMs),
with the whole attempt contained in its own try/catch falling back to
Rule A on any failure. Scenarios EE–EH (end-to-end refined cut + exact
undo; failure containment; refined Firefox-shaped chain through the real
stitched save with assertNoOverlap; seam-gap/noop never attempt
refinement). One intended behavior change: the keep-whole promotion —
T in the gap after a cluster's last block now keeps that whole cluster
instead of dropping it (pre-existing DO re-pinned via the
expectedBlockCut oracle; all its undo/data-loss assertions unmodified).
Harness 148 scenarios / 1041 assertions. Remaining: owner acceptance
(BUILD_LOG Testing, v1.22.1 block — precision, late-cut, undo, re-cut,
nothing-else-moved, Chrome spot-check).

**CLOSED (2026-08-03): owner acceptance PASSED, B1–B6, both browsers** —
cut precision lands within a second of the scrubbed time (vs ~7.5s
Firefox / ~1s Chrome before), undo exact, re-cut consistent, no
regressions in the surrounding review-pane flows. Two unrelated findings
from the pass, both fixed same day in v1.22.2: the Screen-toggle
click-at-load guard confusion (dark-with-intent click now opens the
picker when the webcam is off; the webcam-on case deliberately keeps its
v1.12 camera-only role — scenario AH caught that hijacking it would have
made camera-only unreachable) and the recorder-panel button-row shift
(Undo re-record moved to its own flex row, so the persistent controls
never reflow).

### 24. Recorder & storage resilience — SHIPPED v1.21 (2026-08-02)

Owner acceptance testing surfaced a Firefox 153 failure: MediaRecorder
intermittently dies silently (no onstop, no onerror, zero chunks; sticky
per browser session; storage healthy — confirmed by in-field console
diagnostics after a storage-wedge theory was ruled out). The app trusted
start(): phantom recordings, silently dead Stop & save (the old
`state==='inactive'` early return), zero-chunk sessions invisible to the
recovery banner. v1.21 ships: start verification (~4s abort of phantom
recordings; salvage — never delete — when footage exists), dead-recorder
salvage in stopRecording, an onstop watchdog with a sync claim flag
(no double-finalize; survives resetUI by design), onerror salvage, a
write-stall warning, and storage watchdogs (openDB / sessionChunkStats
races with restart-Firefox guidance; qm-shutdown-hangs Bugzilla family).
Orchestrator review caught 5 draft defects incl. a data-loss delete and
a prematurely-disarmed watchdog. Scenarios DV(a)–(h)/DW(g). v1.21.1
(same day, owner field data): grace re-check before calling a
live-looking zero-chunk recorder a phantom (10s total; inactive still
aborts at 4s), paused recordings never judged, and the abort message
leads with restart-Firefox (the failure is sticky per browser session —
retry without restart fails identically; first live detection fired
correctly 4s into the owner's session). Harness 137/936. Owner
acceptance of the resilience behaviors owed (BUILD_LOG v1.21 manual
list). Firefox ~154 may fix the upstream regression; v1.21's guards stay
valuable regardless. **v1.21.2 (same day): ROOT CAUSE found and fixed —
the app requested `…,opus` unconditionally; FF153 silently records
NOTHING on `vp8,opus` with a video-only stream (owner-reproduced
deterministically via console experiment; vp9 isn't supported by FF at
all, so FF always landed on the broken combo). Opus is now requested
only when the stream has audio (scenario DX; harness 138/940). The
failure was never intermittent — it was configuration-determined
(no-mic recordings always died; mic recordings always worked).**

### 23. Pause → change screens → resume — owner-requested (2026-08-02)

While paused, let the user pick a different screen/window, then resume —
so the recording never captures the hunt for the next screen. Scoped
2026-08-02 (Sonnet recon, orchestrator-reviewed): **small-to-medium, and
NOT pipeline-touching by construction** — MediaRecorder records the
compositor canvas's capture stream, not the screen stream, so swapping
what feeds `screenVideo.srcObject` is invisible to the recorder, chunk
writes, and every save flow. The swap logic already exists in
`selectScreen()` (stop old tracks → `captureScreen()` → reassign →
restart compositing); it's only gated away because `btnSelectScreen` hides
during recording. Pause is `MediaRecorder.pause()` while the draw clock
keeps painting, so the canvas is live and ready for a new source; doing
the swap while paused also sidesteps the black-frames-at-switch
limitation (nothing is encoded during the swap). The ONE genuinely new
piece: the WebAudio mix (`createAudioMix`) connects source nodes once at
record start — a new screen's system audio must be connected into the
existing destination node (and the old source disconnected; don't leak
nodes on repeated swaps). Verify in a real browser that a deliberate
`track.stop()` during the swap doesn't trip `selectScreen`'s
ended-listener (which calls `stopRecording()` when `state.recording`).
UI: show a "Change screen" affordance only while paused. Differential
tests must show recorded bytes/save flows unchanged; new tests for the
swap-while-paused state machine and audio-mix reconnection.

### 25. Review-pane take controls: redo last take + typed timestamp (owner-requested 2026-08-03)

From the owner's #21 F6 pass: after a cut + new take, re-doing that take
requires manually scrubbing back to the seam. Two additions to the review
pane: **(a) "Redo last take"** — one click discards the newest segment
whole and re-arms continue-recording at its start; this is the existing
whole-segment cut (`cutAtByte === 0`, v1.19) applied at `segIndex = last`,
so precision is exact (segment boundary — no cluster rounding) and Undo
works unchanged. Show only when the recording has 2+ segments. **(b) a
typed `m:ss` timestamp input** beside "Re-record from here," validated and
fed into the same `computeCutPlan` path as scrubbing (until #22, the cut
still lands on the nearest cluster boundary at-or-before T — say so in the
UI). Sonnet drafts, orchestrator reviews; differential tests must show the
save flows unchanged.

### 20. Final-build full regression pass — owner-requested (2026-07-29)
Before calling any build "final," the owner will re-test EVERY feature
end-to-end, not just the newest version's additions. The master checklist is
the accumulated set of manual acceptance lists in BUILD_LOG's Testing section
(crash resilience, continue recording, multi-crash, cancel-save, seeking,
background-tab draw, streaming-save memory, zero-prompt load + camera-only,
Firefox cancel/failed download, and the v1.18 caption-editor list), run in
both browsers, Firefox first. Per-version acceptance passes (including
v1.18's initial pass, 2026-07-29) do not substitute for this. Pairs naturally
with #19 — same "when the feature set stabilizes" trigger.

---

## Feature map vs. the research-derived plan

**Tier 1 (~70% done):** DONE — screen+webcam+mic, PiP (drag/resize/shape — exceeds
plan), pause/resume, mic noise suppression, crash recovery + continue + stitching, no
account/watermark/limits. OPEN — chapter-marker hotkeys (small), caption editor with
VTT/SRT import/export (the accessibility differentiator; ADA Title II deadlines make
this the highest-value open feature), sidecar-file export convention
(`lecture.webm` + `lecture.vtt` + `lecture.chapters.json`).

**Tier 2:** the EBML stitcher already built for crash recovery is most of the plumbing
for take-based recording ("re-record slide 15") — segment concatenation with a UI on
top. The hardest Tier 2 feature is half-built by accident.

**Suggested build order:**
1. P0 fixes (#1–3) + background-tab test/fix (#4) — one session  ✓ DONE v1.6
2. Streaming save (#5)  ✓ DONE v1.11 (single-segment) + v1.13 (multi-segment stitch)
3. Chapter hotkeys + sidecar export (small, completes recording-side Tier 1)
4. Caption editor with VTT/SRT import (borrow from laubonghaudoi/subtitle-editor, MIT —
   see prior-art recon in project memory `project_screen_recorder.md`)
5. mediabunny remux-on-save: Cues/seeking + MP4 export (#6)
6. Take-based recording UI on the existing stitcher

---

## Ground rules that still hold (from BUILD_LOG.md, endorsed by this review)

- Crash resilience is the core feature; test crash scenarios after any pipeline change.
- WebM / streamable container only for recording; MP4 only as a remux-at-save option.
- Zero-dependency stays the default; mediabunny (MPL-2.0) is the one pre-approved
  exception when Cues/MP4 work begins — vendor it, document the trade-off.
- Faculty audience: error messages suggest actions, never expose stack traces.
- File Edit Rule: show proposed changes to Blue and wait for approval before writing.
