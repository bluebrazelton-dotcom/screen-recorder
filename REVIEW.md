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

### 5. Every save materializes the whole recording in RAM — ✓ FIXED v1.11 for single-segment saves (streamed two-pass save: per-chunk cursor pulls → bounded-carry index scan with byte-identical output to the buffered `makeSeekable` → streamed FSA writes on Chrome / reference-composed download Blob on Firefox; any indexing doubt still saves un-indexed; the page-load recovery banner cursor-sums instead of chunk-`getAll`; save progress shown. Multi-segment stitching stays buffered with a documented ceiling — BUILD_LOG Known Limitation #1 — and streaming stitch is the queued follow-on.)
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
10. **`confirm()` fallback in `stitchAndSave`** (~line 1809): replace with in-app
    buttons (matches faculty-audience convention; blocking dialogs are hostile UX and
    break automation/testing).
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
2. Streaming save (#5)  ✓ DONE v1.11 (single-segment; streaming stitch queued)
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
