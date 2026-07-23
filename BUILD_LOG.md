# DidaRec — Build Log

*For handoff to future agents (Fable 5 review, etc.). Documents every version, decision, bug, and architectural choice.*

---

## Project overview

**DidaRec** — a free, open-source, browser-based screen recorder, part of the **DidaWorks** productivity suite. Built for faculty. Single HTML file, zero dependencies (v1). Crash-resilient by design: every second of recording is saved to disk as it happens via IndexedDB. If the browser crashes, the recording survives.

**Repo:** github.com/bluebrazelton-dotcom/screen-recorder
**License:** MIT
**Target browsers:** Chrome 86+, Edge 86+ (File System Access API + getDisplayMedia); Firefox first-class since v1.9 (saves via download fallback with in-app arrival confirmation; writes 8-byte unknown-size cluster VINTs — see v1.8.1)
**Architecture:** Single `index.html` file, inline CSS + JS, no build step, no server

---

## Version history

### v1.0 — Walking skeleton (2026-07-20)

**Commit:** `v1 walking skeleton`

Core recording pipeline: screen + webcam + mic capture, canvas compositing with PiP overlay, MediaRecorder with 1-second timeslice, IndexedDB chunk storage, crash recovery on reload, File System Access API for saving.

**Architecture decisions:**

- **MediaRecorder + IndexedDB** chosen over mediabunny StreamTarget for v1. Rationale: zero dependencies, simpler mental model, proven browser APIs. mediabunny identified as v2 upgrade path for MP4 output and streaming-to-disk.
- **IndexedDB** chosen over OPFS or direct File System Access API for crash resilience. IndexedDB writes are immediately persistent and survive tab crashes. File System Access API's `createWritable()` uses a swap file that isn't committed until `close()` — data loss on crash. OPFS requires a Worker and has less browser support.
- **WebM container** (VP9 preferred, VP8 fallback). WebM is streamable — a truncated file still plays up to the cut point. Standard MP4 requires an index written at end-of-file; truncation = corruption. This is critical for crash resilience.
- **Canvas compositing** for screen + webcam PiP. The canvas draws both video sources and `captureStream(30)` produces a single combined video track. This avoids MediaRecorder's limitation of one video track per recording.
- **AudioContext mixing** for mic + system audio. Multiple audio tracks are mixed through `createMediaStreamDestination()` into one track for the recorder.
- **Promise chain for chunk writes** to prevent race condition where the last `ondataavailable` chunk hasn't been written when `onstop` fires.

**Bugs found and fixed during build:**

1. **mimeType fallback bug:** `finalizeRecording()` called `getIncompleteSession()` after `completeSession()` marked the session complete. Since `getIncompleteSession()` filters for `!completed`, it never found the session and couldn't read the mimeType. Fix: read mimeType directly by session ID before marking complete.

2. **Last chunk race condition:** `ondataavailable` is async but the browser doesn't await it. When `stop()` fires, `onstop` would call `finalizeRecording()` before the last `addChunk()` write committed. Fix: chain chunk writes through a `lastChunkWrite` promise; await it in `onstop` before finalizing.

3. **Mic stream leak:** The mic stream from `getUserMedia` was stored in a local variable inside `startRecording()` and never saved to state. `cleanupStreams()` wouldn't stop mic hardware tracks, leaving the mic indicator on. Fix: store in `state.micStream`, stop tracks in `cleanupStreams()`.

4. **Camera-only mode clipping:** When screen was off and camera was on, the canvas drawing logic entered the PiP block, applied a small rounded-rect clip path, then tried to draw camera at full canvas size — but the clip was still active, so only the small PiP rectangle was visible. Fix: restructured drawing logic to check `!state.sources.screen` first and draw full-canvas without clip.

---

### v1.1 — Device selectors + footer note (2026-07-20)

**Commit:** `add device selectors and footer note`

- Added in-app camera and microphone selector dropdowns using `navigator.mediaDevices.enumerateDevices()`
- Dropdowns appear below the Webcam and Mic toggle buttons
- Screen source gets a text hint ("Browser picks the source") since `getDisplayMedia()` screen selection is a browser security requirement and cannot be bypassed programmatically
- Device hot-plug support via `devicechange` event listener
- Brief permission request on load to populate device labels (Chrome hides labels until permission is granted)
- Footer note explaining the browser's screen-share popup

**Decision:** Screen selection cannot be done in-app. The `getDisplayMedia()` API is intentionally locked behind a browser-controlled picker for security. This is a browser platform constraint, not a limitation of the app.

---

### v1.2 — Two-step screen selection flow (2026-07-20)

**Commit:** `add two-step screen selection flow`

- Added "Select Screen" button (green outline style) to the left of Record
- Clicking it triggers the browser's screen picker and shows a live preview on the canvas
- Record button stays disabled until a screen is selected (when Screen source is active)
- After selection, button changes to "Change Screen" to allow re-selection
- If screen share ends before recording starts (user cancels in browser), UI resets gracefully
- Camera-only mode: Select Screen button hides, Record enables directly
- Footer updated to reference the new flow
- Placeholder text updated: "Select a screen to preview, then click Record"

**Rationale:** Blue (the user) found it confusing that clicking Record immediately triggered the browser's screen picker. The two-step flow lets users see what they're about to record before committing, which is better UX for the target audience (faculty who may not be tech-comfortable).

---

### v1.3 — Continue Recording + WebM stitching (2026-07-20)

**Commit:** `add continue recording with WebM stitching`

**New feature:** When the app detects an interrupted recording on reload, the recovery banner now shows three options:
1. **Continue Recording** — preserves the interrupted recording's chunks in IndexedDB, lets the user start a new recording. When they stop, all segments are automatically stitched into one file.
2. **Recover & Save** — saves the interrupted recording as-is (existing behavior, now also stitches multiple segments from repeated crashes).
3. **Discard** — deletes the interrupted recording data.

**Architecture: EBML/WebM parser (zero dependency)**

Rather than adding mediabunny or ffmpeg.wasm as a dependency, the stitching is handled by a custom ~150-line EBML parser built specifically for this use case. WebM files use the EBML binary format (similar to XML). The parser:

1. Scans a WebM file's binary structure to find Cluster elements (which hold the actual audio/video data)
2. Reads each Cluster's timestamp
3. For the second file onward, rewrites each Cluster with an adjusted timestamp (offset by the duration of all prior segments)
4. Produces a combined file: first segment's header/tracks + all clusters from all segments with corrected timestamps

This is **remuxing, not re-encoding** — the actual compressed video/audio data is copied byte-for-byte. It's fast, lossless, and works because all segments from the same recording session use the same codec and resolution.

**Key EBML concepts for future maintainers:**
- Element structure: `[ID (variable-length)] [Size (variable-length)] [Data]`
- Variable-length integers: width determined by leading bits (like UTF-8). 1-8 bytes.
- For IDs, the leading bits are part of the value. For sizes, they're stripped.
- "Unknown size" = all value bits set (commonly used for the Segment element in MediaRecorder output)
- Cluster element (ID 0x1F43B675) contains: Timestamp child + SimpleBlock children
- Cluster Timestamp (ID 0xE7) is milliseconds from segment start
- SimpleBlock timestamps are relative to their parent Cluster — no modification needed

**Fallback behavior:** If EBML stitching fails (malformed data, unexpected structure), the app falls back to saving each segment as a separate numbered file via the File System Access API picker.

**Multi-crash support:** The recovery system detects ALL incomplete sessions in IndexedDB, not just the most recent. If a user crashes three times during one logical recording, all three segments are preserved and can be stitched or continued from.

**State change:** Added `state.priorSegments` array to track session IDs of interrupted recordings that should be stitched with the current recording on save.

---

### v1.3.1 — EBML stitching fix (2026-07-20)

**Bug:** "EBML size too large" error when stitching recordings via Continue Recording.

**Root cause:** Chrome's MediaRecorder writes Cluster elements with "unknown size" VINT markers (all value bits set). The `webmScan()` function tried to find unknown-size cluster boundaries by parsing child elements, but would fail when children also had unknown sizes or when parsing hit unexpected data. This caused the scanner to treat the rest of the file as one giant cluster. Then `webmRewriteCluster()` tried to write a known size for the combined data, which exceeded the 4-byte VINT limit (max ~268MB), triggering the error in `ebmlWriteSize()`.

**Fixes (three changes):**

1. **`ebmlWriteSize` fallback:** Instead of throwing when a value exceeds the 4-byte limit, fall back to the 8-byte "unknown size" VINT (`[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]`). WebM players handle unknown-size clusters correctly.

2. **`webmScan` byte-scanning:** Replaced the fragile child-element parsing approach for finding unknown-size cluster boundaries with a simple byte-scan for the Cluster ID pattern (`0x1F 0x43 0xB6 0x75`). Also fixed a bug where timestamp wasn't read from unknown-size clusters (was inside an `if (!sizeField.isUnknown)` guard).

3. **`webmRewriteCluster` size preservation:** Added `sizeIsUnknown` flag to cluster info. When the original cluster had unknown size, the rewriter now preserves that instead of computing a known size — preventing the too-large error entirely.

---

### v1.3.2 — Crash-recovery stitching fix (2026-07-20)

**Bug:** "invalid or out-of-range index" error when stitching crash-recovered recordings.

**Root cause:** When the browser closes mid-recording, the last chunk stored in IndexedDB is truncated (the browser died before finishing it). The EBML parser's `ebmlReadUInt()` function had no bounds checking, so it would try to read past the end of the truncated buffer, crashing with a RangeError. Additionally, `webmScan()` used `segEnd` (based on the Segment element's declared size) without clamping it to the actual buffer length, which could also cause out-of-bounds reads on truncated files.

**Fixes:**

1. **`ebmlReadUInt` bounds check:** Returns 0 instead of throwing when reading past the buffer end.
2. **`safeEnd` clamping:** All element boundary calculations in `webmScan()` now use `Math.min(declaredEnd, buffer.byteLength)` to handle truncated files.
3. **Per-segment scan failure tolerance:** `concatenateWebM()` wraps each `webmScan()` call in try-catch. If a corrupted segment can't be parsed, it falls back to including raw bytes rather than crashing the whole stitch.

---

### v1.4 — Webcam preview + draggable/resizable PiP (2026-07-20)

**New features:**

1. **Webcam preview before recording:** Toggling the Webcam button now immediately starts the camera and shows it on the canvas — no need to hit Record first. Works in both screen+camera and camera-only modes. The camera stream is reused when recording starts (no double-capture).

2. **Draggable PiP window:** Click and drag the webcam overlay to reposition it anywhere on the preview canvas. Cursor changes to a grab hand when hovering over the PiP.

3. **Resizable PiP window:** A grip pattern in the bottom-right corner of the PiP can be dragged to resize the webcam overlay. Clamped between 8% and 50% of canvas width. The grip only shows during preview and disappears during recording so it doesn't appear in the output.

4. **Persistent layout:** PiP position and size are saved to `localStorage` as fractions of canvas dimensions. Survives page reloads, different screen resolutions, and recording sessions.

**Architecture decisions:**

- **Fractional coordinates:** PiP position (`xFrac`, `yFrac`) and size (`widthFrac`) are stored as fractions of canvas dimensions (0–1), not pixels. This means the layout adapts correctly when screen resolution changes or a different screen is selected.
- **Mouse coordinate mapping:** Canvas display size differs from internal resolution. Mouse events are mapped using `(clientX - rect.left) * (canvas.width / rect.width)` to get accurate canvas-space coordinates.
- **localStorage for persistence:** Chosen over IndexedDB because the data is tiny (3 numbers) and IndexedDB is already doing heavy lifting for crash-resilient chunk storage. localStorage is synchronous and simpler for this use case.
- **Preview-only resize handle:** The grip lines are rendered in the `drawFrame()` loop but only when `!state.recording`. During recording, the canvas output is clean — the PiP is there but the handle isn't burned into the video.

**New functions:** `startCameraPreview()`, `stopCameraPreview()`, `canvasCoords()`, `getPipRect()`, `isInPip()`, `isInResizeHandle()`, `savePipLayout()`, `endPipInteraction()`.

**State addition:** `pipState` object with `xFrac`, `yFrac`, `widthFrac`, `dragging`, `resizing`, `dragOffsetX`, `dragOffsetY`.

---

### v1.5 — PiP shape selector + branding (2026-07-20)

**New feature:** Webcam shape selector dropdown under the Webcam toggle with three options:

1. **Rectangle** — natural camera aspect ratio with rounded corners (default, same as before)
2. **Square** — 1:1 crop with sharp corners
3. **Circle** — 1:1 crop clipped to a perfect circle

For square and circle shapes, the camera feed is center-cropped to 1:1 using `drawImage`'s source-rectangle parameters (`sx`, `sy`, `cropSize`) so the face stays centered rather than getting stretched. The circle uses a `ctx.arc()` clip path; the square uses `ctx.rect()`.

Shape selection is saved to localStorage alongside position and size. The dropdown is disabled during recording and when the webcam is toggled off.

**Hit detection:** `isInPip()` updated with a point-in-circle test for the circle shape (distance from center ≤ radius).

**Branding:** Project renamed from "Screen Recorder" to **DidaRec**, part of the **DidaWorks** productivity suite. Updated page title, header, footer, README, and build log.

---

### v1.6 — Data-loss fixes + background-tab freeze fix (2026-07-20)

**Commit:** `fix P0 save-flow data loss and background-tab freeze`

Fixes the three P0 data-loss bugs from the Fable 5 review (REVIEW.md) plus the P1
background-tab freeze (#4). All three data-loss bugs were in the SAVE flow, not the
recording pipeline — the crash guarantee (~1s max loss) is unchanged.

1. **Cancel-save no longer deletes the recording.** `saveFile()` now returns `true`
   (saved) / `false` (cancelled). `finalizeRecording()`, `stitchAndSave()` (main +
   separate-files fallback) and `recoverRecording()` delete sessions only after a
   confirmed write. A cancelled save keeps the recording; it reappears in the
   recovery banner on reload.

2. **Sessions are no longer marked complete before saving.** A recording stays
   "recoverable" until its bytes are on disk — `deleteSession` (on a confirmed save)
   is the only thing that retires it. Closes the window where a cancelled or
   interrupted save left a `completed` session that the recovery banner skipped and
   `cleanupCompleted()` swept. `completeSession()` is now unused.

3. **Multi-crash recovery saves every segment.** When stitching fails during
   recovery, each segment is saved as its own numbered file (was: only the newest
   segment saved, then ALL sessions deleted — losing the earlier segments). Only
   sessions whose data was actually written are deleted.

4. **Silent chunk-write failures now stop gracefully.** On an `addChunk` failure
   (most likely `QuotaExceededError` when IndexedDB fills on a long recording), the
   app shows a plain-language error, stops the recorder, and routes through the
   normal finalize path so everything recorded so far is written to disk (via the
   File System Access API, which the full IndexedDB quota does not block). Refuses
   further chunks after the first failure so the stream can't develop a gap.

5. **Background-tab freeze fixed (#4).** Compositing no longer freezes when the tab
   is hidden (e.g. switching to full-screen slides). Chrome pauses
   `requestAnimationFrame` in hidden tabs, which froze the recorded video while
   audio kept going. The draw loop now runs on a Web Worker timer while the tab is
   hidden and on rAF while visible, switching on `visibilitychange`. The worker is
   an inline blob — still zero external dependencies, still one file.

**Architecture note:** the draw loop is split from its clock. `drawOneFrame()` draws
exactly one composited frame; `startDrawClock()` selects rAF (visible) or a Web
Worker `setInterval(33ms)` (hidden) and swaps on `visibilitychange`. New `state`
fields: `drawFrame`, `drawWorker`, `drawWorkerUrl`.

**Verification:** the save-flow and clock logic were extracted and tested in Node
with a mocked File System Access API, MediaRecorder, Worker and an in-memory
IndexedDB (10 scenarios, 32 assertions): cancel-keeps / save-deletes for the single,
stitch and recovery paths; recovery-stitch-fail saves each part and deletes only
what was written; a quota failure stops and finalizes with the good chunks; the
clock switches rAF↔worker on visibility. The background-tab freeze itself needs the
manual test below (a real hidden-tab screen recording can't run headless).

---

### v1.7 — Recording size controls (2026-07-20)

**Commit:** `add quality selector + 1080p cap to control file size`

Addresses the "huge output" report (a 38-minute recording was ~500 MB at the old
fixed 2.5 Mbps). At a fixed target, file size tracks bitrate × duration, so the lever
is bitrate.

1. **Quality selector.** A new dropdown by the Mic controls: Smaller file (~0.8 Mbps)
   / Balanced (~1.2, default) / Best quality (2.5). Drives `videoBitsPerSecond`. The
   choice is saved to localStorage and disabled during recording. Balanced roughly
   halves the file for slide/lecture content.

2. **Audio bitrate pinned** at 128 kbps (`audioBitsPerSecond`) for predictable total
   size.

3. **1080p capture cap.** `startCompositing()` caps the canvas at 1080p height
   (aspect preserved) when the screen is larger (1440p/4K). Fewer pixels means the
   lower bitrate looks clean and the encoder spends less. PiP is unaffected (it uses
   fractional coordinates). Screens at or below 1080p are untouched.

Verification: extended the Node harness (now 12 scenarios, 38 assertions) — the
selector value reaches `videoBitsPerSecond`, audio is pinned, and the canvas caps to
1920×1080 for 4K/1440p while passing 1080p/720p through unchanged.

---

### v1.8 — Seekable output: save-time Duration + Cues (2026-07-21)

**Commit:** `make saved recordings seekable (save-time Duration + Cues remux)`

Closes REVIEW.md P1 #6 and Known Limitation #2. MediaRecorder writes a "live" WebM:
unknown Segment size, no `Duration` in `Info`, no `Cues` (seek index) — so players
don't know the total length and can't jump around (confirmed on a 38-minute
recording: no scrubbing at all). **Option A** was chosen deliberately: a
zero-dependency finalize pass reusing the existing EBML toolkit, instead of adding
mediabunny (Option B, rejected to keep the zero-dependency architecture).

**`makeSeekable(blob)`** runs once at the top of `saveFile()`. Because every save
path funnels through `saveFile` (single, stitched, recovered, separate-part
fallback), all saved files get indexed automatically. It is **metadata-only
remuxing** — cluster bytes are copied verbatim, nothing is re-encoded. Final layout:

```
[EBML Header][Segment( SeekHead → Info(+Duration) → Tracks → Clusters… → Cues )]
```

1. **Duration** (`0x4489`, an IEEE float — 8-byte big-endian, in timestampScale
   ticks): max block timestamp in the last cluster, guarded by the highest cluster
   timestamp seen anywhere, plus one ~30fps frame (33ms). This alone makes the
   scrubber show total length.
2. **Cues:** one CuePoint per cluster whose FIRST video `SimpleBlock` is a keyframe
   (`flags & 0x80`) — non-keyframe clusters are skipped, not cued. Positions are
   relative to the Segment DATA start in the final layout, written as fixed-width
   8-byte uints (stable element sizes ⇒ one-pass layout math).
3. **SeekHead** first in the Segment, pointing at Info, Tracks, and Cues (players
   need it to find Cues at the end of a Segment with unknown size).
4. **Segment size stays UNKNOWN** (the 8-byte marker MediaRecorder writes). A known
   size isn't needed for seeking and would exceed `ebmlWriteSize`'s 4-byte cap on
   recordings over ~268 MB.

**Safety contract:** the whole pass is wrapped in try/catch plus structural sanity
checks (missing/oversized Info or Tracks, clusters before the preamble, layout math
mismatch → bail). On ANY failure the ORIGINAL blob is returned unchanged — a
recording that saves un-seekable is acceptable; a recording that fails to save is
not. The recording pipeline (`addChunk`, timeslice, recovery) is untouched; the ~1s
crash-loss guarantee is unaffected.

**Also in this change:** `webmScan` now records the EBML header end, Segment data
start, and Info/Tracks regions (used by `makeSeekable`), and its unknown-size
cluster byte-scan requires a Timestamp element (`0xE7`) as the first child of a
candidate Cluster — closing REVIEW.md P2 #8 (false-positive cluster boundaries in
compressed data), which matters now that the seek index is built from those
boundaries.

**Verification:** Node harness extended to 16 scenarios / 64 assertions. New: a
synthetic Chrome-shaped WebM (unknown-size Segment + 1-byte unknown-size clusters,
video+audio tracks, keyframe and non-keyframe clusters) is indexed and re-verified
structurally — Duration float correct, SeekHead entries resolve, every
`CueClusterPosition` lands exactly on a Cluster ID, non-keyframe cluster skipped;
the full `finalizeRecording` path writes an indexed file; corrupt input returns the
identical original blob; a truncated (crash-tail) file still indexes from its intact
clusters. All 12 prior scenarios pass unchanged (their fake blobs exercise the
fallback path through `saveFile`). Independent check: `ffprobe` reads the injected
duration exactly and reports zero container errors. Real-recording seek tests in
Chrome (short + 5–10 min, single/stitched/recovered): see manual acceptance tests.

---

### v1.8.1 — Firefox pause/resume truncation fix (2026-07-21)

**Commit:** `fix Firefox truncation: byte-pattern unknown-size VINT detection + coverage guard`

**Bug (found by Blue in real Firefox testing):** a paused-and-resumed recording saved
in Firefox played only up to the pause point. Forensics on the failing file showed
ALL the data present (cluster timestamps 0 → 67,521ms) but `Duration` stamped as
7,519ms — the length of the first cluster. Firefox's player trusts the metadata and
refuses to play past the declared end, so v1.8's new Duration field walled off
everything after the first cluster. (v1.7 had no Duration, so Firefox derived length
itself — which is why this never showed before.)

**Root cause — REVIEW.md P2 #9, no longer harmless:** Firefox writes every Cluster
with the 8-byte unknown-size VINT (`0x01 FF FF FF FF FF FF FF`); Chrome uses the
1-byte form (`0xFF`). `ebmlReadVarInt`'s unknown-size check compared numeric values,
and for width 8 the all-ones value and the largest known value round to the same
float64 — so the marker parsed as a huge KNOWN size, `webmScan` clamped it to EOF and
saw the whole recording as ONE cluster, and the Duration walk stopped at the second
cluster's header.

**Fixes:**

1. **Byte-pattern unknown-size detection** in `ebmlReadVarInt`: a size is unknown iff
   all value bits are set — checked on the bytes, not the parsed number. Closes P2
   #9 for real. Chrome files are unaffected (1-byte markers were already detected);
   the Segment's 8-byte marker is now detected directly instead of being rescued by
   `safeEnd` clamping.

2. **Coverage guard in `makeSeekable`:** `webmScan` now reports `scanEnd` (how far
   the top-level scan got). If more than 4KB of the file lies beyond it, the rebuild
   is skipped and the original blob is saved un-indexed — indexing must never
   silently drop tail data it didn't understand.

**Verification:** harness now 18 scenarios / 81 assertions — new: byte-pattern VINT
detection cases (1/2/8-byte unknown markers; legit 8-byte known size keeps its exact
value); a Firefox-shaped synthetic file (8-byte cluster markers) fully indexes with
Duration from the LAST cluster and per-cluster CuePoints; a coverage-guard scenario
proves early-scan-stop returns the original blob. On the real failing file: fixed
scan finds 10 clusters (0→67,521ms), re-index writes Duration 74,539ms, and ffprobe
independently reads 74.539s. Previously saved v1.8 Firefox files can be repaired by
re-running them through the fixed `makeSeekable`.

**Scope note:** Firefox is now a supported target (it's the project owner's primary
browser). Firefox saves via the download fallback (no File System Access API);
recording, crash recovery, stitching, and seeking all apply.

---

### v1.9 — Firefox-first: unconfirmed downloads no longer count as saves (2026-07-23)

**Commit:** `fix Firefox cancel/failed-save data loss: tri-state saveFile + download confirmation`

**Bug (REVIEW.md #14, P0):** Firefox has no `showSaveFilePicker`, so `saveFile()` fell to
the `a.click()` download fallback and returned `true` unconditionally; every caller then
treated the save as confirmed and called `deleteSession`. A cancelled "Save As" dialog
(Firefox set to "Always ask you where to save files") or a failed download (disk full,
permissions) deleted the recording with no recovery path — the v1.6 cancel-preservation
guarantee did not hold in Firefox, now the primary browser.

**The constraint:** a fire-and-forget download can't report success or cancellation —
there is no API for it. So the fix is not "detect the cancel"; it is "stop treating an
unconfirmed download as a confirmed save."

**Fixes:**

1. **Tri-state `saveFile`:** returns `'saved'` (FSA wrote + closed), `'cancelled'` (FSA
   AbortError), or `'downloaded'` (fallback fired; arrival unconfirmed). All six caller
   sites updated: `'saved'` deletes the session (unchanged), `'cancelled'` keeps it
   (unchanged), `'downloaded'` keeps it until the user confirms.
2. **Download confirmation bar:** after a fallback download, an in-app bar asks
   "Downloaded — did it arrive?" — "It's there — all set" deletes the session(s);
   "It didn't arrive — keep my recording" keeps them recoverable. If the bar is ignored,
   the recovery banner on next load is the backstop. (Sweep policy chosen by Blue:
   immediate affordance with banner backstop.)
3. **Multi-part loops** (stitch-fail fallback, recovery separate parts): a downloaded
   part no longer breaks the loop or deletes its session; all parts download and one
   confirmation bar resolves them together.

Chrome/Edge FSA path is behavior-identical (only the return values renamed).

**Firefox sweep (this pass, all verified clean in code):** codec falls to `vp8,opus`
(Firefox has no VP9 encoder; existing fallback chain handles it); system audio absent
from Firefox screen capture — guarded, mic-only mixes without error (limitation #7);
worker draw clock browser-agnostic (worker timers unthrottled in Firefox); IndexedDB
ephemeral in Firefox private windows (limitation #8); picker cancel (`NotAllowedError`)
already handled. REVIEW P2 #7 (permission prompt on load) noted as elevated in Firefox —
its own session.

**Verification:** harness now 22 scenarios / 99 assertions — new Firefox-mode scenarios
(no `showSaveFilePicker` in the mock): single download keeps the session and confirm
deletes it; decline keeps the recording recoverable; stitched download keeps all 3
sessions until confirmed; recovery stitch-fail downloads both parts and keeps both until
confirmed. All 18 prior scenarios pass unchanged (FSA path regression-checked by
scenarios A–F). Real-Firefox acceptance (cancel the "Always ask" dialog → recording
survives) is the manual test below.

---

### v1.10 — Mirror webcam option (2026-07-23)

**Commit:** `add mirror-webcam toggle (flips preview AND recording)`

A "Mirror webcam" checkbox under the webcam controls flips the camera horizontally.
Because the preview canvas IS the recording (`captureStream` records the same pixels),
the flip applies to both — mirror-preview-only would require a second draw pipeline.
Caveat: written text held up to a mirrored camera reads backwards in the saved file.

- Works in all modes: PiP (all shapes — the flip is around the PiP's own vertical
  axis, so position/drag/resize are unaffected) and camera-only.
- Off by default; persisted in the `pipLayout` localStorage entry alongside position,
  size, and shape; disabled during recording (same convention as the shape selector).
- Implementation: nested `save()/translate/scale(-1,1)/restore()` around the camera
  `drawImage` — the clip path stays active, and the border stroke is unaffected
  (paths aren't part of the context state stack).

Verification: visual (no Node-harness coverage for canvas transforms, consistent with
v1.4/v1.5 PiP features); harness re-run green (22 scenarios / 99 assertions).

---

### v1.11 — Streaming save: bounded-memory single-segment saves (2026-07-23)

**Commit:** `stream single-segment saves: bounded memory, byte-identical output`

Closes REVIEW.md P1 #5 for single-segment saves (the normal save path and
single-crash recovery). Previously every save materialized the whole recording
roughly three times over — chunk `getAll` → full-recording Blob →
`makeSeekable`'s contiguous `arrayBuffer` — so a 3-hour Best-quality lecture
(~3.5 GB) could OOM the tab at the finish line. Worse, because sessions delete
only on `'saved'`, an OOM at save didn't lose data — it LOOPED: recovery
re-attempted the same buffered path and died the same way, leaving the
recording unsaveable.

1. **`saveFile` grew a source type.** `saveFile(source, suggestedName)` takes
   either a Blob (buffered path — code unchanged) or
   `{ kind: 'session', sessionId, mimeType }` (streamed). Session sources:
   single-segment finalize, single-segment recovery, and the stitch shortcut
   when only the current segment has data. Blob sources (stitched files,
   separate-part fallbacks) keep the existing `makeSeekable` path. The
   tri-state return and every v1.9 caller-gating line are unchanged.

2. **Pass 1 — streaming index scan.** `createWebmStreamScanner()` re-implements
   `webmScan`'s decisions over the chunk stream with a hard-capped carry buffer
   (`STREAM_CARRY_CAP`, 64 MB): EBML preamble, cluster boundaries (including
   Firefox's 8-byte unknown-size markers, with candidate boundaries that
   straddle chunk edges held until the up-to-13 bytes needed to validate them
   arrive), per-cluster keyframe check and max block time while the bytes are
   still in carry. Retains only `[0, segmentDataStart)`, the Info and Tracks
   elements, and ~40 bytes of metadata per cluster — Duration is known before
   anything is written, so there is no backfill patch and no v1.8.1-style
   wrong-Duration hazard. Any doubt (cap hit, sanity guard, truncated
   Timestamp, > 4 KB unparsed tail) → the save streams the raw chunk bytes
   verbatim instead: un-indexed but intact. Never a partial index; never a
   guessed Duration.

3. **Pass 2 — sinks.** Chrome/Edge (FSA): the picker opens FIRST (cancel →
   `'cancelled'`, zero work done), then pass 1, then a second chunk walk
   writes SeekHead → Info(+Duration) → Tracks → the recorded cluster ranges
   sliced from each chunk → Cues. `'saved'` only after `close()` resolves; a
   mid-write failure calls `abort()` (FSA's swap file never lands) and the
   session is kept — same recovery story as today. Firefox (download): each
   chunk is wrapped in a small Blob during pass 1 and the final download Blob
   is composed from `slice()` REFERENCES to those chunk Blobs — peak memory
   drops from ~3× the recording (one copy contiguous) to ~1×, browser-managed,
   with no contiguous full-file buffer. The v1.9 confirmation-bar flow is
   unchanged.

4. **Shared builders.** The SeekHead / Info+Duration / Cues writers were
   extracted from `makeSeekable` (`webmBuildInfo`, `webmBuildSeekHead`,
   `webmBuildCues`, `webmSeekHeadLen`) and are called by BOTH paths, so the
   buffered and streamed head layouts cannot drift.

5. **Riders.** `checkForRecovery` now cursor-sums chunk counts and bytes
   (`sessionChunkStats`) — the recovery banner no longer loads every chunk of
   every session at page load. Streamed saves show faculty-plain progress:
   "Preparing your video…" during the scan, then "Saving… N%" in whole numbers
   every ~5% during the write.

**Chunk iteration note:** `forEachSessionChunk` opens one connection and pulls
ONE chunk per short-lived transaction (keyed after the last index, gap-
tolerant). A long-lived cursor can't span the write loop — IndexedDB
transactions auto-commit whenever the event loop turns on external work (an
FSA `write()`), which is why the pulls are per-chunk by design.

**Verification:** harness now 30 scenarios / 183 assertions. The star is the
differential suite: five fixture shapes (Chrome-style 1-byte cluster markers,
Firefox 8-byte markers, truncated crash tail, audio-only → Duration-only,
coverage-guard poison) × adversarial chunk splits (every byte its own chunk,
mid-cluster-ID, mid-size-VINT, mid-Timestamp, thirds) — streamed output must
be BYTE-IDENTICAL to `makeSeekable` run on the concatenated blob, for indexed
files and bail cases alike (an un-indexed streaming save emits the raw bytes,
which is exactly the buffered fallback's original blob). Also: picker cancel
does zero work (no pass 1, no writes); an injected mid-write failure calls
`abort()` and keeps the session recoverable; progress reaches 100% and the
session deletes only after `close()`; chunk-index gaps stream what's there;
the Firefox composed download is byte-identical through the real finalize
path; banner numbers are correct via cursor-sum; a forced carry-cap bail still
saves the raw recording. All 22 prior scenarios pass unchanged — the FSA mock
now aggregates `write()` calls per file handle and pushes one combined Blob on
`close()`, so existing "files written" assertions keep their original meaning.

**Real acceptance (owner, both browsers):** a genuinely long recording
(≥ 30–60 min, Best quality) with Task Manager open — memory roughly flat
during save; output seeks correctly; kill-tab crash on a long recording →
recover → save succeeds; then a short (~15 s) sanity clip. See the manual
test below.

---

## Known limitations

1. **Memory usage during stitching (multi-segment only):** single-segment saves stream with bounded memory since v1.11, but `concatenateWebM` still loads every segment into memory for multi-segment stitching (Continue Recording chains, multi-crash recovery). Very long multi-segment recoveries — roughly beyond 2–3 hours of total footage at Balanced quality — may fail to save on low-RAM machines. Streaming stitch is the queued follow-on.

2. ~~**No seeking in output:** MediaRecorder-produced WebM files lack a Cues element (seek index), so players can't seek precisely. This affects both single and stitched recordings. Fix would require writing Cues at save time.~~ — ✓ Fixed in v1.8: `makeSeekable()` writes Duration + Cues at save time (zero-dependency remux in `saveFile`). Files that fail indexing still save, just un-seekable.

3. **WebM only:** No MP4 output. Some platforms (iOS, older Android) have limited WebM support. mediabunny could add MP4 output in a future version.

4. **Timestamp estimation:** When stitching, the duration of each segment is estimated as `lastClusterTimestamp + 1000ms` (one cluster duration). This could produce a tiny gap or overlap at the stitch point. Imperceptible in practice but technically imprecise.

5. **No black frame detection:** Screen switching mid-recording produces a few black frames. Detecting and removing these would require frame-by-frame analysis (decode → inspect → re-encode), which is a significant complexity increase. Noted for future exploration.

6. **Single-file architecture:** The entire app is one HTML file with inline CSS and JS. This is intentional (zero build step, easy to deploy), but limits code organization as features grow. Consider splitting if the file exceeds ~2000 lines.

7. **No system audio in Firefox:** Firefox's screen capture does not provide system/tab
   audio; Firefox recordings capture microphone audio only.

8. **Firefox private windows:** IndexedDB is in-memory in private browsing, so crash
   recovery does not survive a private-window crash. Record in a normal window.

---

## Future features (roadmap)

- ~~**Webcam preview before recording**~~ — ✓ Done in v1.4
- **Screen switching mid-recording** — swap the screen source without stopping (browser picker interrupts briefly; produces black frames at the cut)
- **Black frame removal** — detect and trim black frames at stitch points (requires WebCodecs decode or canvas analysis)
- **mediabunny integration** — replace MediaRecorder with WebCodecs + mediabunny for MP4 output and streaming-to-disk (Cues/seeking no longer needs it — done zero-dependency in v1.8)
- **Trimming** — basic start/end trim before saving
- **Two-step tool** — separate lightweight video editor page for stitching, trimming, and cleanup (keeps the recorder simple)
- ~~**Project name**~~ — ✓ Named **DidaRec** (part of DidaWorks) in v1.5

---

## File structure

```
screen-recorder/
├── index.html      # The entire app (HTML + CSS + JS, ~3300 lines)
├── README.md       # Project description and usage
├── LICENSE         # MIT License
├── BUILD_LOG.md    # This file
├── REVIEW.md       # Fable 5 code review — tracked items + build queue
└── test.cjs        # Node harness (30 scenarios / 183 assertions; npm i fake-indexeddb)
```

---

## Dependencies

**Runtime:** None. Zero external libraries. All code is inline in `index.html`.

**Browser APIs used:**
- `MediaRecorder` — recording
- `getDisplayMedia` — screen capture
- `getUserMedia` — camera and microphone
- `Canvas` + `captureStream` — video compositing
- `AudioContext` + `MediaStreamDestination` — audio mixing
- `IndexedDB` — crash-resilient chunk storage
- `File System Access API` (`showSaveFilePicker`) — save to disk
- `navigator.mediaDevices.enumerateDevices` — device selection
- `localStorage` — PiP layout persistence

**Development:** No build tools, no package manager, no transpilation. Edit the HTML file, push to GitHub, GitHub Pages deploys automatically.

---

## Testing

**Manual acceptance test (crash resilience):**
1. Open the app, start recording screen + mic
2. Record for 15-20 seconds
3. Kill the tab (Ctrl+W) or kill the browser from Task Manager
4. Reopen the app
5. Recovery banner should appear with chunk count and size
6. Click "Recover & Save" — file should play up to the crash point

**Manual acceptance test (continue recording):**
1. Start recording, record for 10+ seconds
2. Kill the tab
3. Reopen — click "Continue Recording"
4. Select a screen, click Record, record for 10+ more seconds
5. Click "Stop & Save"
6. The saved file should contain both segments stitched together as one continuous video

**Manual acceptance test (multi-crash continue):**
1. Record, crash, reopen — click "Continue Recording"
2. Record again, crash again, reopen — banner should show 2 prior segments
3. Click "Continue Recording" again, record, stop normally
4. Saved file should contain all three segments stitched in order

**Manual acceptance test (cancel-save preserves recording):**
1. Start recording, record for 10+ seconds
2. Click "Stop & save"
3. When the browser's save dialog opens, click Cancel
4. Status should confirm the recording was preserved (not deleted)
5. Reload the page — the recovery banner should reappear with the recording,
   which can then be recovered and saved

**Manual acceptance test (seeking, v1.8):**
1. Record a short (~15s) clip and a longer (~5–10 min) one; save normally
2. Open each saved file in Chrome — the scrubber must show the total length
3. Click around the timeline and use arrow keys — playback must jump correctly
   both forward and backward, landing cleanly (keyframe-aligned)
4. Repeat for a stitched (Continue Recording) file and a crash-recovered file —
   both also pass through `saveFile` and must be seekable

**Manual acceptance test (background-tab draw loop):**
1. Start recording screen + mic with something animating on screen (a video or timer)
2. Fully cover or minimize the tab for ~60s while the on-screen content keeps moving
3. Stop and save, then scrub the portion recorded while the tab was hidden
4. The video should keep updating through that window (not a frozen frame)

**Manual acceptance test (streaming save memory, v1.11 — both browsers):**
1. Record a genuinely long session (≥ 30–60 min at Best quality)
2. Stop & save with Task Manager / about:memory open — the tab's memory should
   stay roughly flat during "Preparing your video…" and "Saving… N%" (no spike
   near the recording's full size)
3. The saved file must play and seek correctly (same checks as the v1.8 list)
4. Kill the tab mid-recording on a long session, reload, Recover & save — the
   recovery save must also complete without a memory spike
5. Finish with a short (~15 s) sanity clip in each browser

**Manual acceptance test (Firefox cancel/failed download, v1.9):**
1. In Firefox, set "Always ask you where to save files" (Settings → General → Downloads)
2. Record 10+ seconds, click "Stop & save", and CANCEL the save dialog
3. The confirmation bar appears; click "It didn't arrive — keep my recording"
4. Reload the page — the recovery banner must reappear, and "Recover & save" must
   produce a playable file
5. Repeat with a normal save; click "It's there — all set" — the session resolves
   (no banner on reload)

---

## Conventions for future agents

- **Zero-dependency philosophy:** Don't add npm packages or CDN scripts unless absolutely necessary. The single-file, zero-dependency architecture is a feature, not a constraint to work around. If a dependency is needed, document the trade-off.
- **Crash resilience is the core feature:** Any change to the recording pipeline must preserve the guarantee that a crash loses at most ~1 second of recording. Test crash scenarios after any pipeline change.
- **Faculty audience:** The user base is non-technical. UI should be self-explanatory. Error messages should suggest actions, not expose stack traces.
- **WebM streamable container:** Don't switch to standard MP4 (non-fragmented) — it requires end-of-file finalization that breaks crash resilience. Fragmented MP4 or WebM are the safe options.
- **File Edit Rule:** When working with Blue (the project owner), show proposed changes and wait for approval before writing. This is from the Aegis Framework standing instructions.
