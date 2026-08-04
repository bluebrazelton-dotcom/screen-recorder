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

### v1.12 — Permission-prompt fix + camera-only discoverability (2026-07-23)

**Commit:** `fix load-time permission prompt (REVIEW #7) + camera-only discoverability`

Closes REVIEW.md P2 #7. `enumerateDevices()` requested a temporary camera+mic
stream on every page load and on every `devicechange` event purely to read device
labels, then released it. Chrome persists the resulting grant so this only ever
prompted once; Firefox does not persist grants by default, so faculty saw a
camera+mic permission dialog on every single load — the worst possible first
impression for a privacy-minded audience, and Firefox is now the primary browser.

1. **No media request at load.** `enumerateDevices()` now calls
   `navigator.mediaDevices.enumerateDevices()` directly. Pre-grant, labels come
   back blank; the existing `Camera N` / `Microphone N` fallbacks cover that.
2. **Lazy grant through existing use sites.** `captureCamera()` and `captureMic()`
   — already the only two `getUserMedia` call sites, reached via the Webcam
   toggle and record-start respectively — each call `enumerateDevices()`
   immediately after a successful grant to upgrade labels while the permission
   is live.
3. **Blank labels never clobber a known-good one.** `enumerateDevices()` now
   snapshots each dropdown's current option labels before rebuilding it; if a
   re-enumerate returns a blank label for a deviceId that already has a real
   name, the real name is kept. This matters specifically for Firefox, which
   blanks labels again once the granting stream's tracks stop.
4. Selection restore (`state.selectedCamera`/`selectedMic` → dropdown value) is
   unchanged and verified to survive the label-upgrade path.

The `devicechange` listener needed no changes — it already calls
`enumerateDevices()`, which is prompt-free after this fix.

**Camera-only discoverability.** Blue's report ("webcam on, screen off exists in
code but I can't reach it") traced to a root cause the original hypothesis didn't
quite capture: `state.sources.camera` defaulted to `true` at page load even though
no camera stream is ever started until the Webcam toggle is explicitly clicked.
An earlier version of this fix tried to paper over that by auto-starting the
camera preview whenever camera-only was entered via Screen-off — but Blue caught
in real-browser testing that this made clicking Screen silently trigger a camera
permission request and take over the viewer, with no message, in both Firefox and
Chrome. That's worse than the original bug and fights the whole point of this
session (no surprise permission requests from a control the user didn't touch).

**Actual fix:** make the default match reality instead of compensating for the
mismatch.

- `state.sources.camera` now defaults to `false` (line ~529) — matching that no
  camera stream is running at load.
- The load handler now calls `updateToggleUI()` (it never had before), so the
  Camera button, `cameraSelect`, `pipShapeSelect`, and `mirrorToggle` all reflect
  the real default state visually from the start instead of relying on a
  hardcoded `active` class in the HTML.
- The at-least-one-source guard still forces Screen back on when both would be
  off, but now always calls `showError()` explaining the revert instead of
  staying silent — this is the part that actually needed a message: a genuinely
  fresh load, click Screen off with nothing else touched, both sources would go
  off, guard fires, message shown.
- Clicking Webcam is now the *only* place a camera stream starts — one clean,
  explicit-gesture permission request, same as before this fix. Camera-only is
  then reached normally: turn Webcam on (preview starts), turn Screen off (guard
  doesn't fire, camera's already on, preview's already showing). No auto-start
  hack needed or present.

**Verification:** harness now 40 scenarios / 200 assertions. New: no
`getUserMedia` call from `enumerateDevices()` at load or on `devicechange`; the
Webcam toggle makes exactly one lazy camera request; `captureMic()` makes a
mic-only request; a blank re-enumerate never overwrites a populated label;
device selection survives the label-upgrade re-enumerate; the guard's revert is
explained via `showError()`; camera-only is reached cleanly when camera is
already on; toggling camera off in camera-only mode reverts with an explanation;
`state.sources.camera` defaults to `false`. All 30 prior scenarios pass
unchanged. Real-browser acceptance (zero-prompt Firefox load, no surprise camera
activation, camera-only end-to-end in both browsers, device labels populating in
Chrome) is the manual test below — owner's step; the auto-start version of this
fix was caught exactly this way, so it's worth re-running fully rather than
spot-checking.

---

### v1.12.1 — Camera-only preview actually renders (2026-07-23)

**Commit:** `fix blank camera-only preview: composite on screen-off, restore placeholder on exit`

**Bug (found by the owner's post-push re-test of v1.12, both browsers):** in the
exact order "Webcam on → Screen off," the viewer stayed blank — `toggleSource`
only started compositing when a screen *stream* existed, so with no screen ever
selected the camera ran into a hidden element while the placeholder sat on the
canvas. The reverse exit had the sibling bug: toggling Webcam off from
camera-only leaves a dead canvas, because the at-least-one guard flips Screen
back ON before `stopCameraPreview`'s `!state.sources.screen` placeholder check
runs.

**Fixes (both directions):**

1. `toggleSource` screen-off path: when the camera source is on and its stream
   is live, restart compositing and hide the placeholder — the camera-only
   preview renders immediately.
2. `stopCameraPreview` no-stream branch: always restore the placeholder (the
   old `sources.screen` check could never be true there after the guard ran).

**Verification:** harness 30 scenarios / 203 assertions — AH/AI extended to
assert what the viewer SHOWS (placeholder visibility + compositing started),
not just toggle state; state-level assertions are exactly how this slipped
through v1.12's otherwise-green run. Real-browser re-test of both directions is
the owner's step. Lesson logged twice in one day: the harness proves logic;
only a browser proves pixels.

---

### v1.12.2 — Download confirm bar appends across saves (2026-07-27)

**Commit:** `append 2nd unresolved download to confirm bar instead of overwriting`

**Bug (queued since the v1.11 close-out; origin: v1.9's download-confirmation
bar):** `offerDownloadConfirm` assigned `downloadPendingIds = sessionIds`, so a
2nd unresolved Firefox download while the 1st confirm bar was still up
overwrote the 1st's session IDs. Confirming then deleted only the newest
sessions; the older ones silently fell back to the recovery banner while the
bar's wording implied it covered everything. Safe (nothing lost) but dishonest.

**Fix:** append with per-ID dedupe instead of overwrite, plus a
`downloadPendingFiles` counter so the bar's message counts every file it now
covers ("Your N recording files were downloaded…"). Confirming deletes every
covered session; Keep is unchanged; both paths reset the counter. Re-offering
an already-covered session still bumps the file count on purpose — the browser
really does write a second file (`recording(1).webm`); the ID dedupe only
prevents double-deletion.

**Also in this version:** `formatDateForFilename()` gains seconds
(`recording-2026-07-27_143258.webm`) — the acceptance test surfaced that two
saves in the same minute produced identical suggested filenames. All save
paths name files through this one function.

**Verification:** harness 31 scenarios / 208 assertions — new scenario AK
drives two unresolved downloads back-to-back and asserts both sessions stay
covered, the message says "2 recording files", a re-offer doesn't duplicate the
ID, and confirm deletes BOTH sessions. Real-Firefox acceptance passed
(2026-07-27): bar reads "Your 2 recording files were downloaded…", confirm
clears both, no recovery banner on reload. During acceptance the owner also
re-verified that Record re-enables after reselecting a screen post-save (a
harness repro of the full record→stop→download→reselect flow passes; an
earlier greyed-button sighting did not reproduce — stale copy or a missed
error banner).

---

### v1.13 — Streaming multi-segment stitch: bounded-memory Continue Recording + multi-crash recovery (2026-07-28)

**Commit:** `stream multi-segment stitch: bounded memory, byte-identical output, in-app fallback banner`

Closes REVIEW.md P1 #5 in full and P2 #10. v1.11 streamed single-segment saves;
every multi-segment save (Continue Recording chains, multi-crash recovery)
still ran `concatenateWebM` — every segment's whole blob in memory at once,
then `makeSeekable`'s own contiguous rebuild on top — peak ≈2–3× total
footage. Beyond roughly 2–3 hours of total footage at Balanced quality, the
buffered stitch could OOM the tab at the finish line, and because sessions
delete only on a confirmed save, an OOM there **looped**: recovery
re-attempted the same buffered path and died the same way. This was
BUILD_LOG Known Limitation #1 (closed — see the edit below).

1. **Pass 1 — per-segment scan, one shared accumulation formula.**
   `scanSegmentsForStitch(segments, onChunk)` walks each segment's chunks in
   order through `createWebmStreamScanner`: segment 1 in the existing v1.11
   default mode (verbatim preamble + cluster ranges); segments 2..N in a new
   `clustersOnly` mode that validates but drops the preamble and, per
   cluster, precomputes the rebased replacement header via
   `webmRewriteClusterHeader` — a helper extracted from the buffered
   `webmRewriteCluster` so both paths share one rewrite implementation
   (including the marker-canonicalization behavior: any rewritten
   unknown-size cluster comes out with the 8-byte `EBML_UNKNOWN_SIZE` form,
   even from a Chrome-shaped 1-byte-marker source — "preserving" the
   original marker would have silently diverged from the oracle). `timeOffset`
   accumulates `prevScan.maxClusterTs + 1000` per prior segment — the exact
   formula `concatenateWebM` uses and the one the harness's `streamedPlanBytes`
   helper independently reimplements, so the two can't drift apart. Any
   segment that fails to scan short-circuits the walk (remaining segments are
   never read) and the whole stitch bails.

2. **Plan build — unchanged, reused.** `buildStitchPlanParts` (already landed
   in the Phase 1 session) merges segment 1's verbatim cluster ranges with
   segments 2..N's (headerBytes + remainder-range) entries into one Duration,
   SeekHead, and Cues, computed before a byte is written. Phase 2 only adds
   the sinks and wiring on top.

3. **Pass 2 — sinks.** `saveSessionsStreamedStitch(segments, suggestedName)`
   mirrors the v1.11 single-segment sinks, generalized to a per-segment entry
   list. Chrome/Edge (FSA): picker first (cancel → `'cancelled'`, zero work,
   no pass 1 run); a pass-1 bail cleans up the swap file FSA already created
   at picker time (`handle.remove()`, best effort) and returns `'bail'`;
   otherwise pass 2 re-walks each segment's chunks, writing segment 1's
   verbatim ranges and, for segments 2..N, each entry's `headerBytes` exactly
   once (a per-entry guard flag) immediately before its remainder range —
   including the edge case where the remainder is empty and lands exactly at
   the segment's end, which the range-slicing loop's strict `<` never admits
   into the main walk and so is flushed right after it. `'saved'` only after
   `close()`; a mid-write failure `abort()`s and rethrows, keeping every
   session. Firefox (download): pass 1 retains per-segment chunk Blob refs +
   running offsets; pass 2 composes head + per-entry (headerBytes + `Blob.slice`
   refs, forward-pointer reset at each segment boundary) + Cues into one
   download Blob — peak ~1×, browser-managed, no contiguous full-chain buffer.

4. **Bail semantics unchanged from the design:** any doubt anywhere in the
   chain (parse failure, zero-cluster segment, carry-cap, a truncated
   known-size final cluster in a non-first segment) bails the WHOLE stitch to
   streamed separate parts — never to the buffered `concatenateWebM`, which
   stays in the file solely as the differential-test oracle and the shape
   the header-rewrite logic was extracted from. This is an intentional,
   documented behavior difference from the old buffered path, which
   tolerated some of these shapes by raw-copying: a zero-cluster or
   truncated-final-cluster segment that used to silently raw-append now
   drives the in-app fallback instead. The same bytes, saved ALONE via the
   v1.11 single-segment path, still save with the existing clamped tolerance
   (scenario M's shape) — the asymmetry is pinned by a differential test
   (`AX`), not incidental.

5. **Rider 1 — streamed parts everywhere.** `saveSegmentsAsParts(segments)`
   replaces every buffered separate-parts loop (`stitchAndSave`'s fallback,
   `recoverRecording`'s stitch-failure fallback) with `{kind:'session'}`
   streamed saves, one v1.11 single-segment save per part — bounded memory
   even in the fallback. `getSessionChunks()` (the chunk-store `getAll`) is
   now unused by any save path and is deleted; the sessions-store `getAll`s
   (`getIncompleteSession`, `checkForRecovery`, `cleanupCompleted`) are
   metadata-only and are unaffected.

6. **Rider 2 (REVIEW P2 #10) — the blocking `confirm()` is gone.**
   `stitchAndSave`'s parse-failure fallback used to `confirm('Stitching
   failed... Save each segment as a separate file instead?')` — a blocking
   dialog, faculty-hostile and untestable. It's replaced by an in-app banner
   (`#stitchFallback`, styled off the existing `.download-confirm` class —
   same visual language as the recovery banner and download-confirm bar) with
   two buttons: "Save as separate files" (`stitchFallbackSaveParts`, drives
   `saveSegmentsAsParts`) and "Not now — keep them stored here"
   (`stitchFallbackKeep`, leaves every session in place with a
   safe-in-the-browser message). Both `stitchAndSave`'s pass-1 bail and its
   catch block (genuine write-time exceptions) route to the same banner.
   `recoverRecording`'s bail path does NOT show this banner — recovery has
   always auto-proceeded straight to per-part saves without a prompt, and
   that pattern is unchanged, just streamed instead of buffered.

7. **Wiring.** `stitchAndSave` and `recoverRecording`'s multi-segment branches
   now call `saveSessionsStreamedStitch` (falling back to a single
   `saveFile({kind:'session'})` call when only one segment actually has data)
   instead of building blobs via `getSessionChunks` + `concatenateWebM`.
   Outcome handling — delete-all-on-`'saved'`, `offerDownloadConfirm` on
   `'downloaded'`, the existing cancel messages — is unchanged; only the
   `'bail'` branch and the write-failure catch are new.

**Verification:** harness grew from 268 to 344 assertions (scenario count:
+7 new — AR through AX). AR is the FSA end-to-end differential (four chains —
Chrome+Chrome, Chrome+Firefox+Chrome, audio+audio, and Firefox+Chrome with
adversarial cluster-ID-boundary and every-byte chunk splits — through the real
`stitchAndSave`, byte-identical to `stitchOracle`). AS is the same differential
through the Firefox download sink. AT proves picker-cancel does zero work; AU
proves a mid-write failure aborts, keeps every session, and offers the
fallback banner; AV proves the bail path reaches the new banner and not the
old `confirm()` (the sandbox has no `confirm` at all — reaching it would throw)
and that a saved part is byte-identical to a lone v1.11 single-segment save;
AW covers `recoverRecording`'s streamed stitch and its bail-to-parts
auto-proceed; AX pins the truncated-known-size-cluster asymmetry (bail in a
chain, tolerated alone). Two existing scenarios (D, S) that seeded
1-byte garbage chunks were reseeded with real WebM fixtures, since the new
bail behavior means unparseable chains no longer reach the save-success
assertions they were written to test. Three more (E, E2, T) had their
forced-throw `concatenateWebM` stubs removed — `recoverRecording` no longer
calls `concatenateWebM` at all, so garbage segments now bail (rather than
throw) into the same parts fallback; E's picker sequence gained one leading
`'ok'` to account for the doomed stitch attempt's own (now-consumed) picker
call before the parts loop starts. Scenario C (cancel) and F
(stitch-success cancel) needed no changes — cancellation happens at the
picker, before pass 1 ever touches segment data. Scenario AO (the buffered
end-to-end differential from the Phase 0/1 sessions) passes unchanged and now
exercises the real streamed path end-to-end, since `stitchAndSave` routes
through it — the whole point of the rewrite is that its assertion (streamed
output === oracle) still holds.

**Grep audit:** no `getAll()` on the chunks object store is reachable from any
save path (the three remaining `getAll()` calls are all on the sessions
store — `getIncompleteSession`, `cleanupCompleted`, `checkForRecovery` —
metadata only); no whole-file `arrayBuffer()` is reachable from a save path
(the three remaining call sites are `addChunk`, a per-chunk conversion on the
RECORDING path, unrelated to saving; `concatenateWebM`, the buffered oracle;
and `makeSeekable`, now reachable only from `saveFile`'s Blob branch, which no
app save flow passes into anymore).

**Real acceptance (Phase 3, 2026-07-28):** Firefox (the primary browser) —
full pass, owner-verified. Chrome — the stitch/save flow worked, but
acceptance surfaced a microphone-capture problem: the recording picked up no
voice, only interference-like sounds. That is a capture-side issue (this
version touched no recording-pipeline code — mic capture is upstream of
everything v1.13 changed) and is tracked as open queue item 1 in
`NEXT_SESSION.md` / the next REVIEW pass. Left for a dedicated diagnosis
session: device-selection suspects first (wrong input device, v1.12
lazy-permission enumeration, OS default/communications split), environmental
causes second.

---

### v1.14 — Mic device selection overhaul: early grant path, anonymized-list guard, graceful degradation (2026-07-29)

**Commit:** `mic device selection overhaul: early grant path, anonymized-list guard, graceful degradation for permission-less environments`

Closes NEXT_SESSION.md open queue item 1 (found during v1.13 acceptance, diagnosed
2026-07-28). Enumeration/selection UI only — the recording pipeline (`captureScreen`,
`MediaRecorder`, chunk store, save flows) is untouched.

**Root causes (four, layered — each one masked the next):**

1. **No pre-recording grant path.** The only mic `getUserMedia` call lived inside
   `startRecording()` via `captureMic()`. Its v1.12 post-grant re-enumerate landed
   exactly as `updateToggleUI()` disabled the select for recording — too late to ever
   be seen. Camera didn't have this problem; the Webcam toggle's preview path already
   grants early.
2. **Pre-grant placeholder options carried `value=""`.** Blank pre-grant deviceIds
   became options with `value=""`, colliding with the Default option's own value.
   Picking one was a no-op — `state.selectedMic` stayed falsy, so no deviceId
   constraint ever reached `getUserMedia`.
3. **Owner-run diagnostic (Chrome 150, file:// scheme, 2026-07-28):** even after (1)
   and (2) were fixed, `enumerateDevices()` kept returning a blank id AND a blank
   label at every stage — pre-grant, DURING a live granted stream, after the stream
   stopped, and on a second grant. An in-app device list is structurally impossible
   in this environment: file:// origins never persist a `getUserMedia` grant, so
   Chrome's own per-capture permission pop-up — which doubles as its own device
   picker — is the only thing that ever worked, and it re-prompts on every single
   `getUserMedia` call.
4. **The original "interference" symptom, finally explained.** With selection inert,
   Chrome fell back to a Bluetooth headset's hands-free profile ("Headset (T9
   Hands-Free AG Audio) (Bluetooth)") — 8–16 kHz telephony-band audio, which is what
   "interference" actually was. Firefox happened to default to the real mic, which is
   why Firefox "worked" all along.

**What was built:**

1. **`primeMicLabels()` — an early mic grant path**, mirroring the camera's early
   preview/grant. Wired to the mic toggle turning ON (forced) and to `#micSelect`'s
   own `mousedown`/`focus` (passive) — both are user gestures, so the
   zero-prompts-at-load guarantee holds even though mic defaults on in
   `state.sources`. Guarded against re-entrancy (`micPrimeInFlight`) and, on the
   passive path, against nagging after one attempt this session
   (`micPrimeAttempted`).
2. **Blank-id placeholder options removed.** `enumerateDevices()` filters out any
   device with `deviceId === ''` before building options — pre-grant, both
   dropdowns are just their Default option; no more `value=""` collision.
3. **Anonymized-re-enumeration guard.** If a re-enumerate for a kind returns entries
   but every one has a blank id (permission lapsed, not a real unplug) and that
   dropdown already holds a granted list, the rebuild is skipped — the v1.12 "a
   blank label never overwrites a known-good one" guarantee, extended to ids. A
   genuinely empty list (no entries of that kind at all) still rebuilds to
   Default-only, same as before.
4. **Persistent `micEnumAnonymized` verdict (`localStorage`).** Once a completed
   grant + enumerate proves the environment can't deliver real names, no prime path
   — passive or forced — prompts again; a click that can only ever repeat the same
   failed pop-up is nagging, not a working control. The verdict self-clears the
   moment any real-option rebuild happens, with no dedicated re-check needed: a
   capable environment shows real names in its own load-time enumerate, or
   `captureMic`'s post-grant fire-and-forget re-enumerate lands them at the first
   recording.
5. **`applyMicDefaultText()`** keeps the Default option honest whenever there are no
   real options: `Microphone: <granted track's own label>` once a track has
   actually been granted, else `Chosen in the browser pop-up` once the anonymized
   verdict is set, else the original `Default microphone`. Never touches a working
   dropdown — no-ops the moment real options exist.
6. **`captureMic()` surfaces the granted track's own `.label`** — a UI-only side
   effect added after the stream is obtained; constraints, error paths, and the
   returned stream are untouched. This is what makes "Microphone: Headset (…)
   (Bluetooth)" or "Microphone: USB Mic" visible during an anonymized-environment
   recording, and it survives a later anonymized re-enumeration (e.g. `devicechange`
   right after the recording stops).

**Verification:** harness now 67 scenarios / 392 assertions (new AY–BK). Covers:
pre-grant enumeration yields Default-only in both dropdowns (no fake placeholders); a
real device list populates real options and feeds the deviceId constraint through to
`getUserMedia`; `primeMicLabels` grants, enumerates while the stream is still live
(before stopping the tracks — Firefox blanks labels once the granting stream ends),
and is a no-op once real options exist; overlapping prime calls make exactly one
`getUserMedia` call; a failed grant doesn't loop-reprompt on the passive path but a
forced (toggle) retry still works — unless the anonymized verdict is set, in which
case NEITHER path prompts and only a real-option rebuild (via
`enumerateDevices`/`captureMic`) clears it; an anonymized re-enumeration preserves a
granted list and its current selection while a genuinely different real list, or a
genuine removal, still rebuilds normally; `applyMicDefaultText` shows the right
placeholder in each state and never touches a working dropdown. `localStorage` mock
upgraded from a no-op stub to a real in-memory store (needed to test the persisted
verdict); element mocks gained `addEventListener` capture (for the mousedown/focus
wiring) and separate Default-option tracking (so `querySelector('option[value=""]')`
works without changing what `querySelectorAll('option[value]')` counts as a real
option — several existing scenarios depend on that count staying placeholder-free).

**Real acceptance (owner, both browsers, 2026-07-29):** Chrome (file:// scheme) —
zero prompts from the dropdown or the mic toggle; only the platform's own
record-start permission pop-up remains, and it doubles as the mic picker in this
environment; "Microphone: \<device\>" shown correctly during recording; real voice on
playback. Firefox — full named dropdown works end to end, no regressions.

### v1.15 — Camera-side honest labels + mic toggle defaults off (2026-07-29)

**Commit:** `camera-side honest labels (shared applyDeviceDefaultText, camEnumAnonymized verdict) + mic toggle defaults off at load`

Closes NEXT_SESSION.md open queue item 1 (owner-requested at v1.14 close-out,
2026-07-29). Enumeration/selection/UI only — the recording pipeline and the
v1.11/v1.13 streamed save flows are untouched.

**What was built:**

1. **`applyMicDefaultText()` generalized into `applyDeviceDefaultText(type)`** —
   one shared helper (`type` is `'mic'` or `'camera'`) picking the right select,
   verdict flag, last-label field, and copy for each kind. Mic behavior is
   byte-for-byte what v1.14 shipped; the camera now gets the same honest Default
   slot: `Camera: <granted track's own label>` once a track has been granted, else
   `Chosen in the browser pop-up` once the camera's anonymized verdict is set, else
   the original `Default camera`. Still no-ops the moment real options exist.
2. **`captureCamera()` surfaces the granted video track's own `.label`** into
   `state.lastCameraLabel` (parallel to `lastMicLabel`), so file://-served Chrome —
   which can never list camera names in-app, same as the mic — still shows the real
   webcam name in the dropdown's Default slot. Survives a later anonymized
   re-enumeration, same as the mic machinery.
3. **Persistent `camEnumAnonymized` verdict (`localStorage`)** — the camera's own
   flag, not shared with `micEnumAnonymized`, since mic and camera are granted
   separately and one going anonymized says nothing about the other. Set/cleared
   inside `captureCamera()` itself rather than a new priming function: the camera
   has no separate prime path (it grants via the Webcam toggle's preview), so
   `captureCamera` is the one place a completed grant+enumerate is known to have
   happened. To read the verdict off the rebuilt dropdown, its internal
   `enumerateDevices()` went from fire-and-forget to awaited — a few extra ms
   during preview/record-start *setup* (before any `MediaRecorder` exists), never
   inside the recording pipeline. Like the mic's verdict, it self-clears the moment
   any real-option camera rebuild happens.
4. **Mic toggle defaults OFF at load, matching the webcam** — `state.sources.mic`
   init flipped to `false` plus the two "mic defaults on" comments rewritten
   (`toggleSource`'s priming hook, the `#micSelect` listener block). Nothing else
   needed changing: `updateToggleUI()` already disables the mic select while the
   toggle is off, and `updateRecordButton()` never referenced mic at all — both now
   verified by scenarios instead. Zero-prompts-at-load still holds and gets more
   natural: the toggle-ON click is now the first mic gesture. v1.14 verdict
   behavior unchanged.

**Verification:** harness now 74 scenarios / 416 assertions (new BL–BR). Covers:
`captureCamera` surfacing the granted track's label when no real options exist and
that label surviving an anonymized re-enumeration (BL); real-option environments
where `captureCamera` touches nothing and the flag stays unset (BM); a completed
blank-id grant+enumerate setting `camEnumAnonymized` and the placeholder explaining
itself (BN); mic and camera verdicts tracked independently in both directions (BO);
the true script-load mic default, snapshotted before any scenario can mutate
`state.sources` (BP); the mic select disabled while the toggle is off, zero
getUserMedia calls until the toggle-ON gesture, which primes exactly once (BQ); the
record-button guard indifferent to mic in both screen and camera-only modes (BR).
No existing scenario needed weakening — the recording scenarios already set
`mic: false` explicitly, and none asserted a mic-on default.

**Real acceptance (owner, both browsers, 2026-07-29, combined with v1.16):**
Chrome (file://) — camera dropdown's Default slot shows the webcam's real name
once granted; mic toggle starts OFF with the dropdown disabled; zero prompts at
load. Firefox — named dropdowns intact end to end, no regressions.

### v1.16 — Mic hold: acquire at toggle-ON, prompt-free record start (2026-07-29)

**Commit:** `mic hold: acquire at toggle-ON and reuse at record, killing the record-time permission prompt`

Owner-reported during the v1.15 browser pass: in environments that don't persist
getUserMedia grants (file://-served Chrome always; Firefox without a remembered
grant), the mic pop-up fired AT THE RECORD CLICK — recording doesn't start until
the grant resolves, so a user who clicks Record and starts talking loses their
opening words to the pop-up. Everything should be set up before Record is clicked.

**The design:** the mic now mirrors the webcam's preview-hold pattern. Stream
setup/teardown and enumeration/selection UI only — the MediaRecorder/chunk-store/
crash-recovery pipeline and the v1.11/v1.13 streamed save flows are untouched.

1. **Toggle mic ON → acquire AND HOLD the stream** (`state.heldMicStream`,
   `acquireMicHold()`). The toggle-ON gesture fires `getUserMedia` — in file://
   Chrome that pop-up doubles as the device picker, and its grant now persists
   into recording via the hold. All v1.14/v1.15 label/verdict machinery runs on
   this path (enumerate while the stream is live, surface the track's own label,
   set/clear `micEnumAnonymized`). Acquired with the same constraints `captureMic`
   uses (shared `micAudioConstraints()`), so the held stream and a recorded stream
   are always built identically. `state.heldMicDeviceId` records the selection
   *at acquisition time* — snapshotted before the `await`, since the select is
   enabled while the prompt is still pending and a drifted selection must not
   mislabel an old-device hold (it instead fails the reuse check below and falls
   back). Toggle OFF → `stopMicHold()`.
2. **`captureMic()` reuses the hold** when it exists, its track is live, and
   `heldMicDeviceId` matches the current selection — zero getUserMedia calls at
   record start, so recording begins instantly. Dead track (Bluetooth dropout),
   drifted selection, or no hold → the pre-v1.16 fresh-acquire path, unchanged.
3. **Dropdown change while the toggle is on → re-acquire** under the new device
   (`onDeviceSelected` stops the old hold first).
4. **Recording stop preserves the hold** (`releaseMicRecordingRef()`, replacing
   the unconditional mic-track stop in `cleanupStreams` and `startRecording`'s
   failure path). While the toggle stays on, held tracks survive recording stop —
   the NEXT recording is prompt-free too. A mid-recording fallback stream gets
   *promoted* into the new hold (stale hold stopped) rather than orphaned. With
   the toggle off, tracks stop exactly as before.
5. **Denied/failed grant at toggle-ON → revert the toggle** with the right
   message: permission copy for `NotAllowedError`, device copy ("connected / in
   use by another app") for everything else. A toggle left on with no hold would
   silently reintroduce the record-time prompt this version exists to kill. A
   grant resolving after the user already toggled off again is stopped, not held.
6. **`primeMicLabels` and the passive mousedown/focus prime are removed** — the
   hold subsumes them. `micEnumAnonymized` no longer suppresses the toggle-ON
   acquisition (that suppression made sense when the toggle prompt was a useless
   nag whose grant evaporated before Record; now it's the setup step). The flag
   governs ONLY the dropdown's honest Default-slot text.

**Behavior change to know:** the mic goes hot at toggle-ON — the browser's
mic-in-use indicator shows before recording starts, same as the camera preview
always has. Zero-prompts-at-load still holds (mic defaults off since v1.15;
nothing acquires outside a user gesture).

**Verification:** harness now 86 scenarios / 472 assertions (new BS–CD). Covers:
toggle-ON acquires exactly once and never stops the tracks (BS); `captureMic`
reuses the hold with zero additional calls (BT); dead-track fallback (BU);
selection change re-acquires under the new deviceId (BV); toggle OFF stops the
hold (BW); recording stop preserves the hold and the next `captureMic` still
makes zero calls (BX); a mid-recording fallback stream is promoted into the hold
(BY); recording stop still stops tracks when the toggle is off (BZ); denial
reverts the toggle with the permission message (CA); a grant resolving after
toggle-off is stopped, not held (CB); a selection change during a pending grant
books the hold under the acquisition-time device and `captureMic` falls back to
the newly-selected one (CC); non-denial failures get device copy, not permission
copy (CD). Ten v1.14-era scenarios (BA–BI, BO, BQ) were deliberately rewritten
because they encoded the prime-then-stop design — notably BI, which asserted the
verdict flag suppresses the toggle prompt, inverted on purpose by this design.

**Real acceptance (owner, both browsers, 2026-07-29):** mic prompt fires at
toggle-ON (where it doubles as the file:// Chrome device picker), Record starts
instantly with voice present from the first word, repeat recordings need no new
prompt, pause/resume unaffected, denial reverts the toggle. Firefox unregressed.

**Field note from this acceptance (platform, not app):** the owner's Chrome now
exposes `showSaveFilePicker` on file:// pages (console check `'showSaveFilePicker'
in window` → `true`, 2026-07-29 — earlier Chrome builds lacked FSA on file://).
Saves therefore take the FSA picker path (`'saved'`, write confirmed by the API)
instead of the download fallback — so the gray `#downloadConfirm` bar no longer
appears in Chrome BY DESIGN; that bar only exists for unverifiable anchor
downloads (still Firefox's path). Initially reported as a missing banner after
Stop & save; a differential harness repro of the full record→pause→resume→stop
flow against v1.15 and v1.16 showed the two versions byte-identical on every
observable in both save modes. Don't chase a missing Chrome save-bar as a
regression — check FSA availability first.

### v1.17 — Caption editor foundation: VTT/SRT parsing, formatting, and serialization (2026-07-29)

**Commit:** `caption editor foundation: pure VTT/SRT parse/format/serialize logic, no UI yet`

Begins Tier 1's highest-value open item (ADA Title II accessibility) per
NEXT_SESSION.md's open queue. This version is FOUNDATION ONLY — pure caption logic
and tests, no DOM, no IndexedDB changes, no UI, and no changes to any existing
function or the recording pipeline. The editor UI (the open-a-file editor model)
lands in v1.18.

**What was built** (new "Caption logic (v1.17)" section, `index.html`):

1. **`parseCaptionTimestamp(str)` / `formatCaptionTimestamp(seconds, sep)`** —
   timestamp parsing tolerant of HH:MM:SS.mmm, any number of hour digits (VTT's
   large hour counts and hand-authored SRT's unpadded `1:23:45,678` both work),
   MM:SS.mmm (VTT's hours-optional form), and either `.` or `,` as the decimal
   separator. Formatting always emits hours (2-digit minimum, more digits past
   99h), clamps negatives to 0, and rounds via a single integer millisecond total
   to avoid the carry bug where 1.9995s naively formats as 00:00:01.1000 instead
   of rolling over to 00:00:02.000.
2. **`parseVTT(text)` / `parseSRT(text)`** — block-based parsers, hardened against
   prior-art recon of laubonghaudoi/subtitle-editor and plussub/srt-vtt-parser
   (both MIT): BOM/CRLF/CR normalized first; a bad cue (wrong arrow, unparseable
   timestamp, end<=start, missing timing line, empty text) increments `skipped`
   and parsing continues rather than aborting the file. VTT keeps cue-settings
   tails verbatim (`settings` field) for lossless round-trip — both surveyed
   prior-art parsers discard them, so this is a deliberate improvement. VTT
   prologue (NOTE/STYLE/REGION before the first cue) is captured verbatim for
   round-trip; the same block types between cues are dropped silently. SRT's
   index line is never kept as `id` (ids regenerate on export).
3. **`detectCaptionFormat(text, filename)`** — content sniff first (WEBVTT header,
   SRT-shaped first block), filename extension fallback, defaults to `'vtt'`.
4. **`serializeVTT({ cues, prologue })` / `serializeSRT({ cues })`** — VTT
   preserves ids/settings/prologue; SRT renumbers sequentially from 1 regardless
   of any original index values. Both emit exactly one trailing newline. Cues
   serialize in array order — sorting is the editor's job, not the serializer's.

**Verification:** harness now 98 scenarios / 566 assertions (new CE–CP). Covers:
timestamp parse/format edge cases including 0, >1h, >=100h, ms-rounding carry, and
negative clamp (CE); VTT round-trip preserving prologue (NOTE+STYLE), cue ids, and
settings verbatim (CF); SRT round-trip renumbering regardless of original indices
(CG); SRT→VTT cross-format conversion (CH); BOM+CRLF/CR normalization (CI); a
missing WEBVTT header parsed best-effort without counting as a skip (CJ);
hours-optional and comma-decimal timestamps tolerated inside VTT (CK); one mixed
VTT fixture (modeled on prior-art's invalid-sample.vtt) proving wrong-arrow,
end-before-start, missing-timing-line, and empty-text cues are each skipped while
good cues still parse (CL); `detectCaptionFormat`'s content-sniff/filename/default
priority order (CM); tags and voice-spans passing through parse→serialize→reparse
untouched in both formats (CN); multi-line WEBVTT header blocks (YouTube-style
`Kind:`/`Language:` metadata) dropped whole instead of miscounted as skipped cues
(CO); whitespace-only separator lines (a stray space/tab on an otherwise-blank
line, common in Windows-authored files) still splitting blocks in both formats
(CP). All 86 pre-existing scenarios pass unchanged.

**Orchestrator review caught three tolerance gaps in the first draft** — multi-line
WEBVTT header blocks miscounted as malformed cues, whitespace-only separator lines
not splitting blocks, and one-digit hours rejected — each fixed and locked in by
CO, CP, and a CE assertion respectively. One known limitation is documented in a
code comment instead of fixed: a non-conformant file with NO blank line between
the WEBVTT header and the first cue still mis-parses (deliberately out of scope).

**Bug found and fixed during test-writing:** the initial `parseVTT`/`parseSRT` draft
left a stray empty string as a cue's trailing text line whenever a block ended in a
single trailing newline (the normal end-of-file case) — a two-line cue would parse
with an extra blank line appended to its text. Fixed by trimming trailing empty
lines from `textLines` before the empty-text-cue skip check, in both parsers.

**No UI, no DOM, no IndexedDB, no state object changes, no recording-pipeline
changes.** The editor surface (open a .vtt/.srt file, edit cues, export) is v1.18.

### v1.18 — Caption editor surface: open-a-file editing UI over the v1.17 caption logic (2026-07-29)

**Commit:** `caption editor UI: open a .webm, edit cues against playback, export a .vtt/.srt sidecar`

Builds the editor UI (the open-a-file editor model) on top of v1.17's pure
`parseVTT`/`parseSRT`/`serializeVTT`/`serializeSRT`/`parseCaptionTimestamp`/
`formatCaptionTimestamp`/`parseCueTimingLine`/`detectCaptionFormat` — none of
that section was reimplemented or modified. Deliberately deferred to v1.19
(not built here): keyboard shortcuts, split/merge cues, chapter markers.

**What was built:**

1. **Mode switching.** A new "Caption editor" button in the recorder controls
   (`#btnCaptionEditor`, neutral-styled like Stop/Discard) calls
   `openCaptionEditor()`, which is refused with faculty-toned copy
   ("Finish or stop the current recording before opening the caption editor.")
   while `state.recording` is true — the button itself is NOT visually
   disabled during recording (see Judgment calls below). Otherwise it hides
   the recorder's preview/status/controls (plain `style.display` toggles, the
   same convention `resetUI()` already uses for individual buttons) and shows
   `#captionEditor` via the existing banner convention (base `display:none` +
   `.visible`). "Back to recorder" reverses both. Neither direction touches
   `state`, held streams, or the recovery/download-confirm banners.
2. **Module-level `captionEditorState`** (precedent: `pipState`, NOT new
   fields on `state`): `cues`, `prologue`, `videoInfo` (`{name, size,
   lastModified, objectUrl}`), `fileKey`, `dirty`, `activeCueIndex`,
   `pendingDraft`, `pendingImport`.
3. **Opening files.** "Open video" (hidden `<input accept=".webm">` + styled
   button) and drag-and-drop onto the editor pane both route through
   `handleCaptionVideoFile(file)`: revokes the previous object URL, creates a
   new one into the app's first real `<video controls preload="metadata">`
   element (the existing `screenVideo`/`cameraVideo` are live-stream sinks
   only — untouched), computes `fileKey`, and checks IndexedDB for a
   matching draft. "Import captions" (hidden `<input accept=".vtt,.srt">`)
   reads the file's text and routes it through `detectCaptionFormat` +
   `parseVTT`/`parseSRT` via `captionParseCaptionText`.
4. **Cue list editing.** Cue rows (start/end time text inputs, a multi-line
   textarea, a delete button) are rendered by `renderCueList()`, which
   contains no editing logic itself — every mutation goes through small
   testable functions that update `captionEditorState` and return
   success/failure: `captionAddCue(currentTime)` (2s default duration,
   placeholder text, keeps `cues` sorted by start), `captionDeleteCue(index)`,
   `captionUpdateCueTime(index, which, str)` (parses via
   `parseCaptionTimestamp`; an unparseable string is rejected without
   mutating the cue — the caller reverts the input and shows the returned
   plain-language message; a valid edit re-sorts and returns the cue's new
   index so the caller keeps it selected), `captionUpdateCueText(index,
   text)`. Row click seeks to `cue.start + 0.001` (the same landing-inside-
   the-cue epsilon trick used elsewhere in caption tooling) without
   autoplaying. `timeupdate` highlights the active cue and only re-renders
   (and thus only scrolls) when the active cue actually changes.
5. **Live caption preview.** `captionPreviewVTT()` is a pure function —
   `serializeVTT({ cues, prologue })` — asserted directly in tests. A single
   `<track kind="captions" default>` child of the video is kept in sync by
   `scheduleCaptionPreviewUpdate()` (debounced ~300ms), which serializes,
   builds a `Blob('text/vtt')` URL, swaps `track.src`, revokes the old URL,
   and sets `track.mode = 'showing'`.
6. **Draft persistence.** `DB_VERSION` bumped to 2; `openDB()`'s
   `onupgradeneeded` now also creates a `'captions'` object store
   (`keyPath: 'fileKey'`), guarded by `objectStoreNames.contains` exactly
   like the existing `sessions`/`chunks` guards, so the upgrade runs cleanly
   on top of an existing v1 database — `sessions`/`chunks` and `deleteSession`
   are otherwise untouched. `saveCaptionDraft()`/`loadCaptionDraft(fileKey)`/
   `deleteCaptionDraft(fileKey)` are the async primitives; edits schedule
   `scheduleCaptionAutosave()` (debounced ~1s). Opening a video whose
   `fileKey` has a stored draft shows an in-app banner (house
   `.recovery-banner` style, reused as-is) — "Continue editing them" /
   "Start fresh" — never a blocking `confirm()`. Importing over a non-empty
   cue list shows the same style of in-editor confirmation before replacing.
7. **Export.** "Save captions (.vtt)" (primary) + a secondary ".srt" button
   call `captionExport(format)`, which serializes via `serializeVTT`/
   `serializeSRT` and saves through the SAME fork `saveFile()` uses:
   `showSaveFilePicker` (with `suggestedName` and proper
   `{description, accept}` types) when available, else `startDownload(blob,
   name)` reused as-is. `suggestedName` is `captionExportFilename(videoName,
   ext)` — the opened video's filename with its extension replaced
   (`lecture.webm` → `lecture.vtt`/`lecture.srt`). Picker cancel
   (`AbortError`) is not an error: a quiet status note, draft untouched.
   A successful FSA save clears `dirty` and says so; the download fallback
   uses the existing honest "Downloaded — check your Downloads folder"
   copy from `startDownload()` and does NOT clear `dirty` (unverified).
   **Export never deletes the IndexedDB draft, on either path** — cheap
   insurance in case the exported file is lost or the user wants to keep
   editing.

**Deliberate decisions worth flagging:**

- **No `beforeunload` changes.** The IndexedDB draft is the safety net for
  the caption editor, same philosophy as the recording pipeline's crash
  recovery — a debounced autosave, not a page-leave warning.
- **Export keeps the draft.** Exporting a file and discarding the working
  draft are two different acts of trust; only "Start fresh" (an explicit,
  named action) deletes a draft.

**Verification:** harness now 108 scenarios / 618 assertions (new CQ–CZ), all
566 pre-existing assertions unchanged. Covers: the v1→v2 DB upgrade adding
`'captions'` while a seeded v1-era `sessions`/`chunks` database survives
untouched (CQ); add/delete/text-edit cue logic including sorted insertion and
an out-of-range delete being rejected without mutating the list (CR);
time-edit re-sort keeping the edited cue's new index findable, and an
unparseable time being rejected without mutating the cue (CS);
`saveCaptionDraft`/`loadCaptionDraft` round-tripping a full record including a
miss resolving `null` (CT); `deleteCaptionDraft` (the "Start fresh" action)
actually removing a stored draft (CU); a partial import (`skipped>0`)
producing the plain-language "N couldn't be read and were left out" message,
with no caveat sentence when nothing was skipped (CV); export filename
extension replacement, including a no-extension fallback (CW); a cancelled
export picker returning `'cancelled'`, never touching `showError`, posting a
quiet status note, and leaving the stored draft intact (CX); the recording
guard refusing editor entry with a plain-language, non-technical message and
leaving the editor pane hidden (CY); and `captionPreviewVTT()` asserted
byte-for-byte equal to `serializeVTT({cues, prologue})` (CZ). Cue-mutating UI
wrapper functions (`onAddCaptionClick`, the per-row `onchange`/`onclick`
handlers, `captionApplyImport`, `captionContinueDraftUI`) are exercised only
indirectly — tests call the pure/async primitives underneath them directly,
which also sidesteps scheduling any real `setTimeout` during the run (see
Judgment calls).

**Orchestrator review caught eight defects in the first draft** (headliners
first): `onCaptionVideoTimeUpdate()` was calling the full `renderCueList()`
on every playhead tick — since textareas only commit on blur, a user typing
a caption while the video played lost their uncommitted text AND input focus
every time the active cue changed, destroying the app's core
transcribe-while-playing workflow; `captionUpdateCueTime` had no end>start
validation, so it accepted an edit that leaves a cue with `end <= start` —
`serializeVTT` would then emit a cue that `parseVTT` itself skips on
reimport and that `<track>` silently ignores; and `updateCaptionPreviewTrackNow`
set `track.mode` on the `<track>` element itself, which is a meaningless
no-op — the real on/off switch lives on `track.track` (the `TextTrack`
object), so captions were never actually guaranteed to render regardless of
what the code believed it had done. Five more, all fixed and test-locked
except where noted: the Firefox/download export path gave zero
caption-specific feedback (reused `startDownload`'s generic recording-save
copy only); opening a video with a saved draft skipped
`renderCueList()`/`scheduleCaptionPreviewUpdate()` on the draft-found branch,
leaving a PREVIOUS video's stale rows visible behind the restore banner;
neither file input reset its `.value` after a pick, so re-selecting the same
file (e.g. reimporting after Start Fresh) silently did nothing; "Back to
recorder" left the video playing (with audio) behind the hidden pane; and
adding a cue or importing captions before any video was open created
orphaned cues with no `fileKey` to autosave under, silently destined to be
wiped by the next video open. All eight are fixed below; new coverage is
DA–DH (DC intentionally skipped — the `TextTrack.mode` fix has no harness
observable, per its own code comment; it's a manual acceptance-pass item).
Harness now **115 scenarios / 649 assertions**, all 618 prior assertions
unchanged.

**Judgment calls / deviations, flagged explicitly:**

1. **"Disabled/refused" implemented as refused-only, not visually disabled.**
   The spec's ground rules explicitly forbid touching the recording
   pipeline; `startRecording()`/`stopRecording()` are where a `disabled`
   toggle for `#btnCaptionEditor` would naturally be wired (alongside the
   existing `btnSelectScreen`/`btnRecord` disables). Editing those functions
   — even by one line — was judged higher-risk than the visual-polish
   benefit, given they're explicitly protected. `openCaptionEditor()` refuses
   with a clear message instead; the button stays clickable but inert during
   recording. Flagging for a follow-up if Blue wants the visual disable too.
2. **Debounced autosave/preview scheduling is only wired into the UI-facing
   wrapper functions, not the pure logic functions.** `captionAddCue`,
   `captionDeleteCue`, `captionUpdateCueTime`, and `captionUpdateCueText`
   never schedule timers themselves — only `onAddCaptionClick`, the
   `renderCueList()` row handlers, `captionApplyImport`, and
   `captionContinueDraftUI`/`captionStartFreshUI` do. This was a deliberate
   design choice (not just a testing convenience) to keep the "small,
   testable functions" genuinely side-effect-free per spec, and it
   incidentally means the test suite never leaves a real 300ms/1s
   `setTimeout` pending when the process exits.
3. **SRT export MIME type** used `application/x-subrip` (no IANA-registered
   type exists for `.srt`) — cosmetic; browsers don't act on it for file
   downloads/FSA writes.
4. **Added three `id` attributes to existing recorder markup**
   (`#previewContainer`, `#statusBar`, `#controlsBar` on the preview
   container, status bar, and controls divs) purely so
   `setRecorderControlsVisible()` can toggle them — no existing CSS/JS
   referenced those divs by class selector, confirmed by grep before adding.
5. **No manual-test-covered feature was skipped** relative to the spec, but
   video `loadedmetadata` duration reading was intentionally left with no
   dedicated status-line display — the native `<video controls>` element
   already surfaces duration, so a redundant status line was scope creep.
6. **Active-cue highlighting now needs a row registry.** Splitting
   `renderCueList()` (structural rebuilds) from `updateActiveCueHighlight()`
   (class-toggle only) required tracking the last-built row elements
   somewhere `updateActiveCueHighlight()` can reach without asking the DOM to
   enumerate its own children (the harness's element mock doesn't support
   that, and a real browser doesn't need to either). Added a module-level
   `captionCueRowEls` array, indexed identically to `captionEditorState.cues`,
   rebuilt (in place — `.length = 0` then repopulated, never reassigned) at
   the top of every `renderCueList()` call. It lives next to `renderCueList`
   rather than inside `captionEditorState` because it's a DOM-projection
   cache, not editor state — nothing about the caption data itself is stored
   there.
7. **The end>start validation added for fix B treats "equal" as invalid too**
   (`start < end` strictly, not `<=`), matching `parseVTT`'s own
   `end > timing.start` check in the v1.17 section — a zero-duration cue
   would be silently unplayable and is rejected the same way an unparseable
   timestamp is.
8. **The video-first guard (fix H) checks `captionEditorState.videoInfo`,
   not `captionEditorState.fileKey`.** They're set together in
   `handleCaptionVideoFile`, but gating on `videoInfo` reads more clearly at
   the call site ("is a video open") than gating on the derived key.

**No changes to the recording pipeline, the v1.11/v1.13 streamed save flows,
or the `sessions`/`chunks` IndexedDB stores.** The v1.17 caption-logic
section is untouched byte-for-byte.

**Real acceptance (owner, 2026-07-29):** initial pass of the v1.18 manual
list passed in the owner's environment. The owner explicitly wants a full
regression re-run of ALL features against the final build before release —
tracked as REVIEW.md #20; the accumulated manual acceptance lists in the
Testing section below are the master checklist for that pass.

---

### v1.19 — Re-record from a timestamp (#21), session 1 of 3: truncation primitive + differential tests (2026-07-30)

**Commit:** `#21 session 1: metadata cut primitive (computeCutPlan + choke-point enforcement) + DI-DL differential tests`

First of #21's three sessions (design signed off 2026-07-30 — see REVIEW.md
#21's Design block). No UI this session; pure plumbing + tests. Truncation
is METADATA, not byte-surgery: stored chunks are never rewritten.

**What was built:**

1. **`setSessionCut(sessionId, cutAtByte, cutAtMs)` / `clearSessionCut(sessionId)`**
   — marker helpers on the session record, same read-modify-put shape as
   `completeSession`. The sessions store is schema-less per-record, so no
   DB version bump. `clearSessionCut` is the future "Undo re-record": the
   tail bytes were never touched, so undo is a full, lossless restore.
2. **Cut enforcement in `forEachSessionChunk`** — one `sessions` get before
   the walk; a valid `cutAtByte` truncates the walk at that absolute byte
   offset (pass-through below it, a TRUNCATED ArrayBuffer COPY at the
   straddling chunk, nothing at/after it). This is the single choke point
   every consumer shares (scan pass, save sinks, stitch, recovery, the
   session-2 preview), so they all inherit the cut identically. With no
   marker the yielded data/index sequence is byte-identical to before.
3. **`computeCutPlan(scans, T)`** — pure cut-point math (Rule A: the
   cluster CONTAINING T is dropped; we never keep content past T), using
   the stitcher's exact `maxClusterTs + 1000` seam formula so preview
   timeline and cut byte can't drift. Returns `startOver` / `noop` /
   `{ kind:'cut', segIndex, cutAtByte, keptMs }`, with `cutAtByte === 0`
   meaning "discard that segment and everything after it whole" (the
   seam-gap and first-cluster cases).

**Judgment calls:**

1. **The marker guard requires `typeof cutAtByte === 'number'`** —
   review-caught defect in the draft: `isFinite(null)` is `true`, so a
   corrupt null marker would have read as "cut at byte 0" and produced an
   EMPTY save. A non-number marker must mean "no cut", never "cut all".
   Pinned by DJ's null-marker assertions. (Orchestrator review pass: 1
   defect caught this session.)
2. **The no-marker path is behaviorally, not textually, identical** — one
   extra short-lived readonly `sessions` get per `forEachSessionChunk`
   call is unavoidable (there is no way to know a marker is absent without
   reading the record). Verified against the full pre-existing baseline.
3. **`cutAtByte === 0` never becomes a stored marker** — plan semantics
   route whole-segment discards to the (session 2) discard flow instead;
   the enforcement still handles a stored 0 sanely (yields nothing).

**Tests:** four new scenarios — DI (`computeCutPlan` unit coverage: mid-
cluster, exact-boundary, start-over, seam-gap, past-end, 2- and 3-segment
chains, Chrome/Firefox/audio-only fixtures), DJ (choke-point enforcement
across split strategies incl. a split exactly at the cut byte; undo
round-trip; null-marker hardening), DK (end-to-end differential: cut saves
through the REAL FSA + download sinks must byte-equal
`makeSeekable(buffer.slice(0, cutAtByte))`), DL (stitched-chain
differential: cut in last segment, cut segment standalone, and a
boundary-cut segment as a NON-FINAL stitch segment — pinning that a
boundary cut never triggers the scenario-AX bail). Harness: **119
scenarios / 722 assertions** (was 115/649), zero regressions.

**No changes to** the live recording pipeline, the v1.11/v1.13 streamed
save flows' logic, `sessionChunkStats` (its byte overstatement for cut
sessions is documented-accepted), or any UI. (Version note: "v1.19" was
provisionally attached to the parked caption-authoring-polish item; that
item is unversioned until built.)

---

### v1.20 — Re-record from a timestamp (#21), session 2 of 3: review pane + "Re-record from here" flow (2026-07-30)

**Commit:** `#21 session 2: Stop & review pane, Rule-A cut application with undo, discarded-session lifecycle, save-as-is; Firefox seam-formula fix`

Builds the user-facing flow on v1.19's metadata-cut primitive. The Stop &
save path is untouched; "Stop & review" branches ONLY inside
finalizeRecording, after capture has fully ended and the last chunk write
is awaited — the recording pipeline and its ~1s-max-loss guarantee are
untouched.

**What was built:**

1. **"Stop & review"** (`#btnStopReview`, shown exactly when Stop is) —
   sets `state.stopMode='review'` and reuses the same stop path. In review
   mode nothing is saved/completed/deleted: the session stays
   `completed:false`, so a crash mid-review still hits the recovery banner.
   During the stop the review button reads "Preparing review..." and the
   Stop & save button's text is left alone.
2. **Review pane** (`#reviewPane`, own `#reviewVideo`, module-level
   `reviewState` — precedent pipState/captionEditorState; same mode-switch
   convention as the caption editor, which is NOT reused: its player is
   File-only and entangled with captionEditorState). Zero-chunk segments
   are filtered out first (stitchAndSave's priorsWithData precedent);
   filtered-to-empty bails to "No recording data found."
   `assembleReviewPreview`: ONE chunk walk per segment feeds both Blob
   parts and a default-mode scanner (earlier cut markers inherited
   automatically at the forEachSessionChunk choke point); single segment →
   makeSeekable; multi → concatenateWebM + makeSeekable — the ONE
   legitimate reach into the buffered oracle path (preview only; every
   save still goes through the streamed sinks). Size guard at ~1.2 GB
   (`REVIEW_PREVIEW_SIZE_WARNING_BYTES`) warns, never blocks, and clears
   once the preview is ready.
3. **"Re-record from here (m:ss)"** — `computeCutPlan` on the scrub
   position: `cut` sets the marker (or flags whole segments
   `discarded:true` for cutAtByte===0), closes the pane into the armed
   Continue-Recording idle state ("Kept m:ss. Select a screen and click
   Record to continue from there."); `startOver` routes to the in-pane
   confirm (never a silent delete); `noop` explains there's nothing after
   the playhead. **Undo re-record** restores the exact pre-cut state — a
   re-cut's PREVIOUS marker verbatim, only THIS cut's discarded sessions
   un-flagged, priorSegments as they were — and disappears the moment a
   new recording starts (tail bytes still live until final save).
4. **Save as is / Discard / Back**: save through the real streamed sinks
   with the standard `recording-<date>.webm` name and identical
   downloaded/bail handling; cancel keeps the user IN the pane ("Save
   cancelled — your recording is still here."); Discard uses an in-pane
   banner confirm; Back arms all segments as priorSegments (the
   Continue-Recording model).
5. **Discarded-session lifecycle**: `setSessionDiscarded` +
   `deleteDiscardedSessions`; excluded from checkForRecovery's list and
   totals; swept at every confirmed-save/explicit-discard site —
   finalizeRecording, stitchAndSave, both recoverRecording successes,
   confirmDownloadArrived, saveSegmentsAsParts, discardRecovery, and the
   review pane's own save/discard.

**Orchestrator review pass: 4 defects caught in the draft** — (a) an empty
final segment could reach the preview assembler; (b) stitched save-as-is
opened the file picker with no filename; (c) cancelling save-as-is dumped
the user out of the review pane; (d) a review stop set the OTHER button's
label to "Saving...". All fixed and test-pinned before ship.

**Post-acceptance fixes (2026-07-30, from owner Firefox testing):**

1. **Review-pane failure hardening** — the owner's first Firefox pass hit a
   silent dead click on "Re-record from here". `assembleReviewPreview` now
   honors the scanner's `finish()` result (a bailed scan sets
   `reviewState.scansOk = false`), `openReviewPane` degrades instead of
   dead-ending (best-effort video; cut button disabled with a plain
   message — watching/Save-as-is/Discard/Back never need a scan), and
   `reviewCutFromHere` is scansOk-gated and try/caught: any failure keeps
   the pane open and says so. Scenario DR pins all of it.
2. **Seam formula fix (the real Firefox bug)** — byte-level analysis of the
   owner's broken stitched file proved Firefox emits ~7.5-SECOND clusters
   (Chrome: ~1s), so the v1.13 seam estimate `maxClusterTs + 1000` rebased
   each next segment up to ~6.5s BEFORE the previous segment's content
   ended — a non-monotonic timeline. Firefox stops decoding video at the
   seam; audio resumes only after the overlap (the owner's exact symptom:
   video frozen from before the cut point, then delayed audio). Fix: every
   seam offset is now the previous segment's actual CONTENT END —
   `Math.max(lastClusterMaxBlockTime, maxClusterTs) + SEAM_GAP_MS` (33ms,
   one frame) — changed in LOCKSTEP in `concatenateWebM` (oracle + review
   preview), `scanSegmentsForStitch` (streamed saves), and `computeCutPlan`
   (cut math); the differential scenarios enforce the three never drift.
   Chrome seams shrink from ~1s of held frame to ~one frame, and
   crash-recovery stitching inherits the fix (closes Known Limitation #4).
   New `syntheticLongClusterWebm` fixture (reproduces the 6.5s overlap
   under the old formula) + scenario DS, including `assertNoOverlap`: it
   re-scans real stitched OUTPUT bytes and asserts the timeline never
   rewinds — the regression check that would have caught this. Scenarios
   AL/AM/AN/DI/DL/DO and the `streamedPlanBytes` helper were updated from
   the old formula's expected values.

**Tests:** DM (stop-mode routing — spies prove review never reaches the
save path; labels checked), DN (preview differentials: single/stitched/
inherited-cut vs the buffered oracles; stored scans match direct scans of
the post-cut bytes), DO (cut + undo incl. M1-restore on re-cut, seam-gap
whole-segment discard, startOver/noop safety), DP (discarded lifecycle
through real save/discard paths), DQ (save-as-is differentials + cancel
preservation), DR (failure hardening), DS (long-cluster seam fix +
no-overlap regression). Harness: **126 scenarios / 812 assertions** (was
119/722).

**Real acceptance (owner, 2026-07-30, Firefox):** full re-record cycle —
record, Stop & review, cut ("it cut where I asked it to cut, cleanly"),
re-record, save — with the stitched output playing smoothly through the
seam; same screen/webcam/mic across takes. Cross-browser pass and the
remaining v1.20 manual list items fold into session 3 / #20.

**No changes to** the live recording pipeline or `sessionChunkStats`.

---

### v1.20.1 — Re-record from a timestamp (#21), session 3 pre-acceptance fixes: Undo chain restore + review-pane handler hardening (2026-07-30)

**Commit:** `#21 session 3 pre-acceptance: fix Undo re-record dropping the reviewed segment; harden reviewSaveAsIs/reviewDiscardConfirmed/undoReRecord`

Found by the session-3 code audit run BEFORE the owner's manual pass of the
v1.20 list (items 4–13 + Chrome) — the audit traced each item's code path
so browser time isn't spent discovering catchable defects.

1. **Undo re-record blocker (manual item 4).** `reviewCutFromHere`
   snapshotted `state.priorSegments` for undo — a value that is stale for
   the entire life of the review pane, because in review mode
   `finalizeRecording` hands the just-stopped session to `openReviewPane`
   without ever writing it into `priorSegments`. So cut → Undo → record →
   Stop & save saved ONLY the new take; the original survived just as an
   orphaned `completed:false` session that resurfaces as a recovery banner
   after a reload. Fix: the undo record now stores the pane's full segment
   list (`restoreSegments: segments.slice()`), making undo's semantics
   "exactly as if you'd clicked Back to recorder instead of cutting" —
   plus the existing exact marker/discard restoration. The non-undo path
   (`priorSegments = keptSegments`) is untouched. The harness had missed
   this because scenario DO pinned the snapshot/restore mechanism with a
   sentinel value — it test-locked the wrong semantics; its two undo
   assertions now pin the full-chain restore.
2. **Handler hardening (the v1.20 silent-dead-click class).**
   `reviewSaveAsIs`, `reviewDiscardConfirmed`, and `undoReRecord` were
   bare async onclick handlers with no try/catch — the same gap that bit
   the owner's first v1.20 Firefox pass, where `reviewCutFromHere` got
   hardened and these three didn't. All three now follow its pattern:
   save-as-is failure keeps the pane open ("Save failed: … Your recording
   is still here — try Save as is again."); discard failure surfaces
   "Couldn't finish discarding the recording. Try Discard recording
   again." (copy deliberately doesn't claim "nothing was deleted" — a
   partial failure may have deleted some sessions; the ops are idempotent
   so retry completes the job); undo failure reports through the
   recorder-level error banner (the pane is closed by then) and does NOT
   consume `reviewState.undo` or hide the button, so a retry works.

**Tests:** DO updated to the corrected undo semantics; new scenario DT
(after DS) pins all three hardened handlers, including the
failed-undo-then-successful-retry cycle. No seam/duration math changed —
AL/AM/AN's pinned literals untouched. Harness: **127 scenarios / 831
assertions** (was 126/812).

**Audit result for the rest of the list:** items 5–13 and the
Chrome-divergence surface (AbortError cancel detection at every FSA call
site, seam math shared — not branched — across cluster sizes) audited
clean in code. The owner's manual pass items 4–13 + full Chrome pass are
still owed — real-browser behavior stays invisible to the harness.

**No changes to** the live recording pipeline or any save flow's byte
behavior (the save/discard logic bodies were wrapped, not modified —
differentials unchanged).

---

### v1.20.2 — Owner-acceptance fixes, batch 1 (2026-08-02)

**Commit:** `v1.20.2: freeze timer + clear stale errors at Stop; instant download-confirm (mark-first, background delete); dismissable error banner; caption sidecar hint`

The owner's manual pass of the accumulated v1.18-era lists surfaced four
bugs and one feature request (queued as REVIEW #23). Fixes:

1. **Timer froze at the Stop click** — `stopTimer()` was only called from
   `resetUI()`, which runs after the ENTIRE async save; the elapsed display
   kept counting until the picker appeared. Now called in `stopRecording()`
   the moment the stop is registered (covers Stop & review too).
2. **Stale error cleared at the Stop click** — `startRecording()` cleared
   the banner at entry but `stopRecording()` didn't, so a pre-stop error
   (e.g. the caption-editor recording-guard message) sat on screen through
   the whole save and, combined with (1), read as "my Stop did nothing" —
   the likely explanation for the owner's "Stop & save dead after the
   recording-guard error" report, which could not be reproduced in code
   (scenario DU now exercises that exact sequence end-to-end; the old CY
   test faked `state.recording` and never actually stopped).
3. **"It's there — all set" responds instantly** — `confirmDownloadArrived`
   awaited a one-row-at-a-time cursor delete of every pending session's
   chunks (5–10s on big recordings, worse when crash-testing piles up
   unconfirmed downloads) before touching the DOM. Now: snapshot + clear
   the queue (double-click = no-op), `completeSession()` each id (cheap
   metadata writes — `checkForRecovery`'s `!s.completed` filter keeps them
   out of the recovery banner even if the tab closes before cleanup), UI
   updates immediately, physical deletes run in an un-awaited background
   task. A marking failure restores the queue and says so — the retry
   stays live. What gets deleted is unchanged; `deleteSession`'s internals
   untouched. (`completeSession` had been unused since the
   recoverable-until-saved change; it now has exactly this one caller.)
4. **Error banner is dismissable** — message moved into `#errorBannerMsg`
   with a × close button (`showError('')`, the existing clear path). A
   call-site audit confirmed no error message is the sole affordance for a
   required action, so early dismissal can't strand anyone.
5. **Caption sidecar hint** — small dim line under the caption export
   buttons explaining the `.vtt`/`.srt` travels next to the video and the
   video file itself is unchanged. Owner decision (2026-08-02): captions
   stay sidecar-only; no burn-in/muxing (most players ignore embedded WebM
   subtitle tracks; re-encoding for pixel burn-in costs realtime duration
   and quality).

**Tests:** AK extended (gated-delete assertions pin marked-complete-before-
swept, chunks-then-gone, double-click no-op, and queue-restore on a marking
failure); new scenario DU (real start/stop mocks: guard refuses
mid-recording, Stop clears the stale error and freezes the timer at the
click, save completes). Harness: **128 scenarios / 855 assertions** (was
127/831).

**No changes to** the recording pipeline, seam/cut math, or any save
flow's byte behavior.

---

### v1.21 — Recorder & storage resilience (REVIEW #24, owner-incident-driven) (2026-08-02)

**Commit:** `v1.21: verify the recorder is alive (start check, stop watchdog, write-stall watchdog, onerror/dead-recorder salvage); storage watchdogs; caption-hint wording`

**The incident:** on Firefox 153 (file://), MediaRecorder intermittently
dies SILENTLY — start() resolves and the UI flips to recording, but no
chunk ever lands and NEITHER onstop NOR onerror ever fires (diagnostic
captured recorderState=inactive, chunksProduced=0, input track still
live, storage fully healthy). The failure is sticky per Firefox session;
a browser restart clears it. The app trusted start(): phantom recordings
ran indefinitely, Stop & save silently no-opped (the old first-line
`state === 'inactive'` early return), zero-chunk sessions vanished from
the recovery banner — the owner's "dead save dialog / no recovery
banner" reports, previously misattributed to a storage wedge that
diagnostics then ruled out. Missing chunk counter ("N chunks saved"
never appearing) is the visible fingerprint.

**What ships — the recorder is verified, never trusted:**

1. **Start verification (H, the centerpiece):** ~4s after start
   (`START_VERIFY_MS`), `verifyRecorderStarted` checks chunks actually
   landed. Zero chunks (recorder missing, inactive, or zombie-"recording")
   → clean abort: claim the finalize flag FIRST (blocks a late onstop
   from finalizing the session being deleted), teardown, delete the
   empty session, plain message ("...Select your screen and click Record
   to try again... restart Firefox"). Chunks-then-died → **SALVAGE, never
   delete** (orchestrator review caught the draft deleting real footage
   here — R1) — routes to the normal finalize/save.
2. **Dead-recorder salvage in stopRecording (E):** the silent early
   return is gone. Idle (`!state.recording`) stays a no-op; recording
   with a dead recorder → message + finalizeRecording saves whatever
   landed. Double-click can't mistrigger it (first click disables both
   stop buttons synchronously).
3. **Stop watchdog (F):** armed before every .stop(); if onstop never
   arrives within `STOP_WATCHDOG_MS` (8s), force-finalize with what's
   stored. `claimFinalize()` (sync check-and-set) makes onstop and the
   watchdog mutually exclusive; onstop only disarms the watchdog AFTER
   winning the claim, so a hung final chunk-write can't silently disarm
   it (R2). `finalizeStarted` deliberately survives resetUI and resets
   only at the next startRecording — a late onstop after a watchdog
   salvage must stay a no-op.
4. **onerror salvage (G):** onerror now arms the stop watchdog and
   attempts recorder.stop() (handleWriteFailure's pattern) instead of
   only displaying the error.
5. **Write-stall watchdog (C):** chunk-write completions stamp
   `lastChunkWriteOkAt` (added statement inside the existing
   ondataavailable chain — the await chain is untouched); an interval
   warns once per stall episode if no write lands for `WRITE_STALL_MS`
   (12s) while recording ("footage up to a moment ago is safe, NEW
   footage is not being captured"). Pause-aware (resume restamps);
   zero-chunk stalls are H's job. All salvage paths force
   stopMode='save' — a dead recorder is never a moment for the review
   flow (R3).
6. **Storage watchdogs (A/B):** checkForRecovery's openDB and
   finalizeRecording's sessionChunkStats race an 8s
   `StorageWatchdogTimeoutError` → restart-Firefox guidance; nothing
   deleted/completed on the timeout path; late-resolving openDB
   connections are closed, not leaked (R5). Firefox storage CAN wedge
   (Bugzilla qm-shutdown-hangs family) even though it wasn't this
   incident's culprit. Streamed save internals untouched.
7. **Caption hint:** "Keep the two files together" → "in the same
   folder" (owner feedback).

Consts are `var` (vm-visible) and test-adjustable: START_VERIFY_MS,
STORAGE_WATCHDOG_MS, STOP_WATCHDOG_MS, WRITE_STALL_MS,
WRITE_STALL_CHECK_MS. Check bodies exposed via `__api` so tests drive
them directly instead of waiting out real timers.

**Orchestrator review caught 5 defects in the draft:** the R1 data-loss
delete, the R2 early watchdog disarm, R3 review-mode routing leak, an R4
start-verify/Stop-click timer race, and the R5 connection leak — all
fixed and regression-pinned (DV(d), DV(g), DV(h) + clearStartVerify in
stopRecording).

**Tests:** scenarios DV(a)–(h) and DW(g). Harness: **137 scenarios /
928 assertions** (was 128/855).

**No changes to** chunk-write logic, any save flow's byte behavior, or
seam/cut math — observation and routing only; every differential passes
unchanged.

**v1.21.1 (same day):** owner field data refined H. (1) A zero-chunk
recorder that still CLAIMS to be alive gets one grace re-check
(`START_VERIFY_GRACE_MS` 6s; 4+6=10s total, past Firefox's ~7.5s
first-blob cadence) before being called a phantom, and a paused
recording defers indefinitely (a zero-chunk pause proves nothing) — a
recorder that is outright `inactive` (the diagnosed signature) still
aborts at 4s. (2) The abort message now leads with the restart —
"Close all Firefox windows and restart Firefox, then select your screen
and try again." — because the failure proved sticky per browser session:
the owner's retry without a restart failed identically. (Same-day
context: the owner's "R1 failure" was in fact R2 passing — Firefox was
already broken at session start and the app called it out in 4 seconds.)
DV(d) pins grace re-arm, paused deferral, and second-check abort.
Harness: **137 scenarios / 936 assertions**.

---

### v1.21.2 — ROOT CAUSE of the silent recorder death: opus requested on audio-less streams (2026-08-02)

**Commit:** `v1.21.2: only request opus when the stream has audio — FF153 silently records NOTHING on 'vp8,opus' with a video-only stream (owner-reproduced deterministically)`

The whole day's "intermittent Firefox recorder death" was DETERMINISTIC
and configuration-triggered — and the app's own doing. The owner's
console experiment (throwaway canvas stream, same healthy session):

- `video/webm;codecs=vp9,opus` → constructor throws NotSupportedError
  (FF doesn't do vp9 — so FF always fell to the next choice…)
- `video/webm;codecs=vp8,opus` on a VIDEO-ONLY stream → **0 chunks,
  state stuck on 'recording', no events** — the silent death, on demand
- `video/webm;codecs=vp8` (no audio codec), same stream → records fine
- browser default, same stream → records fine

The app requested `…,opus` unconditionally; any recording without a mic
or system audio (screen-only, screen+webcam) named an audio codec for a
stream with no audio track. Older Firefox tolerated it; 153 does not.
"Restart Firefox fixed it" was coincidence (source toggles between
attempts). Fix: `audioCodecSuffix = audioStreams.length > 0 ? ',opus' : ''`
threaded through the existing vp9→vp8→default fallback chain. Audio
recordings are byte-identical in behavior to before; audio-less
recordings now request a video-only codec string.

The v1.21 watchdogs remain fully earned: start-verification is what
turned this from "silent phantom recordings" into "diagnosed via three
console pastes," and it still guards every other way a recorder can die.

**Tests:** scenario DX — video-only recording requests AND stores a
mimeType with no opus; mic-on requests opus. Harness: **138 scenarios /
940 assertions**.

---

### v1.21.3 — Screen toggle lit state tracks the live capture, not intent (2026-08-03)

**Commit:** `v1.21.3: Screen toggle lights only while a screen is actually selected; cancelled re-selection fully resyncs the UI (#21 owner pass finding)`

The one finding from the owner's full #21 acceptance pass (Part R +
F1–F15 Firefox + C1–C13 Chrome — everything else passed): the Screen
button rendered as toggled-ON whenever `state.sources.screen` was true,
i.e. at page load, after every recording, and after a share ended — all
moments when no screen is actually selected. Unlike camera/mic (whose
toggle-ON click acquires the stream), Screen's toggle is pure intent;
capture happens in the separate Select Screen step, so lit-state and
reality diverged.

**Fix:** `updateToggleUI` lights Screen only for
`state.sources.screen && !!state.screenStream`, plus `updateToggleUI()`
calls at the three places the stream changes outside `toggleSource`:
selectScreen success, selectScreen failure/cancel, and the share-ended
listener. `resetUI` already called it, so post-recording accuracy is
inherited.

**Adjacent bug fixed in the same pass** (found auditing the cancel
path): cancelling a RE-selection ("Change Screen" → cancel the picker)
had already stopped the old stream but only reset the button text —
leaving stale 'selected' styling, a stale-enabled Record button
(record-time guard existed, but the button looked live), and a dead
black preview canvas with the placeholder still hidden. The catch block
now removes the styling, restores the placeholder when no stream
remains, and re-syncs toggle + Record state.

No pipeline, save-flow, or state-machine changes — pure display sync.

**Tests:** scenario DY (toggle unlit with intent-but-no-stream, lit
after selectScreen, dark + reset after share-end, full resync after a
cancelled re-selection, never lit with intent off) + ORIG/resetState
now capture/restore `getDisplayMedia` like the other media mocks.
Harness: **139 scenarios / 955 assertions**.

---

### v1.22 — Block-precision re-record cut (#22), session 1 of 2: refinement primitive + differential tests (2026-08-03)

**Commit:** `v1.22 (#22 session 1): refineCutToBlock + readSessionByteRange + computeCutPlan segOffsetMs/clusterIndex + DZ-ED differential tests`

First of #22's two sessions (design signed off 2026-08-03 — see REVIEW #22's
Design block). No UI this session; pure plumbing + tests, exactly the v1.19
pattern. The cut stays METADATA — the refinement just computes a
finer-grained `cutAtByte`, landing INSIDE the dropped cluster at a block
boundary instead of at the cluster's start. Precision goes from ~7.5s
(Firefox clusters) / ~1s (Chrome) to ~one block (~33ms video cadence).

**What was built:**

1. **`refineCutToBlock(clusterBytes, clusterTs, localT)`** — pure function,
   no I/O. Walks one cluster's children with byte offsets: skips Timecode,
   cuts at the FIRST SimpleBlock whose absolute time exceeds localT
   (positional first-exceed — every kept block <= T even with track
   interleave and negative relTs). Returns `{relCutOffset, keptEndMs}` or
   null → caller keeps the Rule A whole-cluster-drop plan. Null on: a
   KNOWN-size cluster (the scenario-AX asymmetry — a truncated known-size
   cluster would bail a chain stitch, so refinement only ever applies to
   unknown-size clusters, which is all either browser's MediaRecorder
   writes); any child that isn't Timecode/SimpleBlock; any malformed or
   overrunning child; zero kept blocks (byte-identical to Rule A anyway).
   Keep-whole is a real outcome (relCutOffset = full cluster length) and
   fixes Rule A's over-drop when T falls in the gap after a cluster's last
   block. `keptEndMs` floors at the cluster timestamp, matching
   `webmMaxBlockTime`'s own floor, so the bookkeeping can never drift below
   the post-cut re-scan's `lastClusterMaxBlockTime` (orchestrator review
   fix — the one defect found in this session's draft).
2. **`readSessionByteRange(sessionId, startByte, endByte)`** — ranged read
   built ON `forEachSessionChunk`, so it sees the same cut-enforced view as
   every other consumer (re-cuts of an already-cut segment stay
   consistent). Single linear pass, bounded copy; no early-abort plumbed
   through the shared choke point (documented tradeoff — one cluster is
   ~2–3 MB worst case).
3. **`computeCutPlan` cut returns now carry `segOffsetMs`/`clusterIndex`**
   (cutAtByte > 0 branch only) — session 2's wire-in derives
   `localT = T - segOffsetMs` and the target cluster from the plan itself
   instead of recomputing seam offsets. Additive; audited every existing
   consumer (DI/DK/DL/DS + the stub-swap) — all field-specific assertions,
   nothing disturbed.

**Tests (44 new assertions, harness 144 scenarios / 999 assertions):**
fixtures `multiBlockClusterWebm` (parameterizable blocks/tracks/markers,
Chrome 0xFF + Firefox 8-byte shapes) and `unexpectedChildClusterWebm`
(Void element mid-cluster); independent oracle `expectedBlockCut` built on
childElems/ebmlReadId/ebmlReadSize (scenario-K style — never calls the
function under test); DZ (8 unit edges incl. the keptEndMs floor), EA (new
plan fields vs the real seam formula, absent on cutAtByte===0), EB (ranged
reads vs oracle slices incl. through an existing cut marker), EC
(single-segment differential: refined cut × both marker shapes ×
mid-chunk/chunk-edge splits × FSA/download sinks ≡ makeSeekable(slice)
oracle), ED (2-segment chain, Firefox-shaped segment 2 refined, stitched
save ≡ concatenateWebM oracle, both sinks).

**No changes to the recording pipeline, the v1.11/v1.13 streamed save
flows' behavior for uncut sessions, or `forEachSessionChunk` itself.**
Remaining: session 2 — wire into `reviewCutFromHere` + owner Firefox
acceptance.

---

### v1.22.1 — Block-precision cut (#22), session 2 of 2: the wire-in (2026-08-03)

**Commit:** `v1.22.1 (#22 session 2): reviewCutFromHere refines the cut to a block boundary (Rule A fallback on any failure); scenarios EE-EH + DO keep-whole companion fix`

`reviewCutFromHere`'s cut branch now attempts refinement between
`computeCutPlan` and `setSessionCut`: fetch the dropped cluster's bytes
(`readSessionByteRange`), run `refineCutToBlock` with
`localT = T - plan.segOffsetMs`, and store the refined byte/keptMs when it
succeeds. The whole attempt is wrapped in its own try/catch that falls
back to Rule A's byte/time on ANY failure — refinement is an enhancement
over an already-shippable plan; a DB hiccup must never turn a workable
Rule A cut into a surfaced error. Undo/discard bookkeeping and everything
downstream are untouched; the "Kept m:ss" status reports the refined
time. Cut precision in the review pane goes from ~7.5s (Firefox) / ~1s
(Chrome) to ~one block (~33ms).

**Behavior note (intended): the keep-whole promotion.** When T falls in
the gap after a dropped cluster's last block, Rule A used to drop that
whole cluster; refinement now keeps it entirely (the cut byte becomes the
cluster's end — for a mid-chain cluster, byte-identical to Rule A
targeting the next cluster). Strictly more good content kept. This is
why pre-existing scenario DO needed a 2-assertion companion fix: its
chosen T values hit exactly this case, and its pinned Rule-A bytes are
now computed through the independent `expectedBlockCut` oracle instead.
Every DO undo-restore and priorSegments assertion (the v1.20.1 data-loss
pins) passes unmodified.

**Tests (42 new assertions, harness 148 scenarios / 1041 assertions):**
EE (end-to-end through the real click handler: refined byte + cutAtMs
stored, refined status, exact undo, pane close, no error); EF (synthetic
readSessionByteRange failure → Rule A byte stored, no banner, v1.20
behavior exactly); EG (refined cut on a Firefox-shaped chain segment via
the click handler, then the REAL stitched save ≡ stitchOracle +
assertNoOverlap seam proof); EH (seam-gap and noop plans never attempt
the ranged read — throwing call-counting stub).

**#22 is code-complete.** Remaining: owner Firefox/Chrome acceptance
(BUILD_LOG Testing section, v1.22 block).

**Owner acceptance PASSED (2026-08-03, B1–B6, both browsers)** — #22
closed. Cut precision within a second of the scrubbed time everywhere.

---

### v1.22.2 — Screen-toggle click semantics + Undo button row (owner findings from the #22 pass, 2026-08-03)

**Commit:** `v1.22.2: dark Screen click opens the picker when webcam is off (guard message no longer fires inaccurately); Undo re-record gets its own flex row (no more control reflow)`

Two findings from the owner's B1–B6 pass, both fixed same day:

1. **Screen toggle click-at-load.** Since v1.21.3 the Screen button
   correctly reads dark when nothing is captured — but clicking it
   flipped the INTENT flag off, tripping the at-least-one guard and its
   "Screen was turned back on" message, inaccurate when no screen was
   ever on. Now: with intent on, no stream, and the webcam OFF, the
   click opens the screen picker directly (page load and the
   post-recording armed state both land here). **Deliberately scoped:**
   with the webcam ON, the same dark click keeps its v1.12 role as the
   camera-only entrance — the first draft shortcut was unconditional,
   and scenario AH caught that it made camera-only UNREACHABLE (Record
   is disabled in screen mode without a stream, so the toggle-off is
   the only path in). The guard's message now only ever fires from the
   Screen button when a screen is genuinely being captured — exactly
   when its wording is accurate. Scenario AG re-pinned to that case
   (live stream survives the guarded no-op); new scenario EI pins all
   four click meanings (dark+webcam-off → picker; lit → toggle-off;
   webcam-only → re-enable intent; dark+webcam-on → camera-only).
2. **Recorder-panel button-row shift.** The armed re-record state's
   extra "Undo re-record" button overflowed `.action-btns`, wrapping
   the whole group to a second row — which snapped back up when
   re-recording started. The button is now a direct child of the
   wrapping `.controls` flex with `flex-basis: 100%; max-width:
   max-content; margin-left: auto` — its own right-aligned row whenever
   visible, zero footprint when hidden, and the persistent controls
   never reflow. Pure CSS/markup; JS toggling and every existing
   test assertion untouched (harness has no layout — owner eyeball
   check owed).

Harness: **149 scenarios / 1053 assertions**.

**Owner eyeball acceptance PASSED (2026-08-03):** picker-on-dark-click
(webcam off), camera-only entrance intact (webcam on), and a stable
control row through the full cut → record → stop cycle.

### v1.23 — Review-pane take controls (#25): "Redo last take" + typed timestamp (2026-08-04)

**Commit:** `v1.23 (#25): review-pane take controls — "Redo last take" + typed m:ss re-record time; applyReviewCutPlan extraction; scenarios EJ–EP`

Both parts of REVIEW #25 in one session, built on one shared refactor:
`reviewCutFromHere`'s cut-application body (block-precision refinement,
undo bookkeeping, discard/marker writes, pane close, "Kept …" status)
moved VERBATIM into `applyReviewCutPlan(plan, T)` — zero logic changes,
proven by every pre-existing DO/EE/EF/EG/EH scenario passing unmodified.
The 'noop'/'startOver' plan kinds stay with each caller (their messages
differ slightly by entry point).

1. **"Redo last take" (#25a).** One click in the review pane discards
   the newest segment whole and re-arms continue-recording at its
   start. `computeRedoLastTakePlan(scans)` builds the plan — the exact
   shape `computeCutPlan`'s own `k===0` branch returns for a T at the
   start of the last segment (same fields, same order, same
   `lastClusterMaxBlockTime`-only keptMs formula; scenario EK pins the
   equivalence with a JSON-equality oracle) — and `redoLastTake()`
   applies it through `applyReviewCutPlan`. Precision is exact (a
   segment boundary — `cutAtByte === 0`, the v1.19 whole-segment
   machinery; refinement never runs on that branch). Button shows only
   with 2+ segments (one segment's "redo" is Back to recorder / Start
   over, not a redo); disabled — not hidden — under the same `scansOk`
   gate as "Re-record from here". Undo is unchanged: same undo record,
   same full-pane-chain restore.
   **NOTE:** `computeRedoLastTakePlan` is a FOURTH lockstep copy of the
   seam-offset formula (`Math.max(lastClusterMaxBlockTime, maxClusterTs)
   + SEAM_GAP_MS`), joining concatenateWebM / scanSegmentsForStitch /
   computeCutPlan — deliberate, matching the documented precedent; any
   future seam-formula change now has four sites.
2. **Typed `m:ss` re-record time (#25b).** A validated text input
   beside "Re-record from here": `parseReviewTimestamp` accepts
   m:ss / mm:ss / h:mm:ss (unbounded minutes/hours, 0–59 seconds and
   in-hour minutes; deliberately NOT the caption grammar, which
   requires fractional seconds), rejects anything else with a gentle
   inline message and touches nothing. A valid time feeds the SAME
   `computeCutPlan()` call scrubbing uses — #22's block refinement
   applies automatically, so the cut lands within ~a second of the
   typed time and no granularity caveat appears in the copy. 0:00 is a
   real time (hits the startOver confirm, same as scrubbing to 0).
   Known nit, deliberately deferred: Enter in the input doesn't submit —
   click the button.

Harness: **156 scenarios / 1122 assertions** (was 149/1053). EJ–EP:
button visibility/gating (EJ), plan-vs-oracle byte-identity + apply +
exact undo (EK), real-stitched-save differential after a redo (EL), the
parser's validation matrix (EM), typed-path rejection/boundary/gate
behavior (EN), typed-vs-scrub byte-identical markers for the same T
(EO), and a second real-save differential through the typed path (EP).
resetState gained DOM resets for the two new controls. No pre-existing
scenario changed.

**Owner acceptance PASSED (2026-08-04), both browsers, all 8 checklist
items:** Redo visibility at 1 vs 2+ segments, redo + undo round trip,
seam playback after a redone take, typed-time cut vs scrub parity,
rejection messages, 0:00 confirm, bailed-scan disabled state. #25
CLOSED.

---

## Known limitations

1. ~~**Memory usage during stitching (multi-segment only):** single-segment saves stream with bounded memory since v1.11, but `concatenateWebM` still loads every segment into memory for multi-segment stitching (Continue Recording chains, multi-crash recovery). Very long multi-segment recoveries — roughly beyond 2–3 hours of total footage at Balanced quality — may fail to save on low-RAM machines. Streaming stitch is the queued follow-on.~~ — ✓ Fixed in v1.13: `saveSessionsStreamedStitch` streams every multi-segment save (Continue Recording chains, multi-crash recovery) with the same bounded-carry two-pass shape v1.11 uses for single segments, byte-identical to the old buffered output. Any doubt in the scan bails to streamed separate-parts saves (never back to the buffered path) with an in-app banner instead of a blocking `confirm()`. `concatenateWebM` stays in the file as the differential-test oracle and the reference the header-rewrite logic was extracted from, but is no longer reachable from any save flow.

2. ~~**No seeking in output:** MediaRecorder-produced WebM files lack a Cues element (seek index), so players can't seek precisely. This affects both single and stitched recordings. Fix would require writing Cues at save time.~~ — ✓ Fixed in v1.8: `makeSeekable()` writes Duration + Cues at save time (zero-dependency remux in `saveFile`). Files that fail indexing still save, just un-seekable.

3. **WebM only:** No MP4 output. Some platforms (iOS, older Android) have limited WebM support. mediabunny could add MP4 output in a future version.

4. ~~**Timestamp estimation:** When stitching, the duration of each segment is estimated as `lastClusterTimestamp + 1000ms` (one cluster duration). This could produce a tiny gap or overlap at the stitch point. Imperceptible in practice but technically imprecise.~~ — ✓ Fixed in v1.20: seam offsets now use the previous segment's actual content end (`lastClusterMaxBlockTime`) + `SEAM_GAP_MS` (33ms). The old +1000ms estimate overlapped by up to ~6.5s on Firefox's ~7.5-second clusters, breaking video decode at every stitch seam (see the v1.20 entry).

5. **No black frame detection:** Screen switching mid-recording produces a few black frames. Detecting and removing these would require frame-by-frame analysis (decode → inspect → re-encode), which is a significant complexity increase. Noted for future exploration.

6. **Single-file architecture:** The entire app is one HTML file with inline CSS and JS. This is intentional (zero build step, easy to deploy), but limits code organization as features grow. Consider splitting if the file exceeds ~2000 lines.

7. **No system audio in Firefox:** Firefox's screen capture does not provide system/tab
   audio; Firefox recordings capture microphone audio only.

8. **Firefox private windows:** IndexedDB is in-memory in private browsing, so crash
   recovery does not survive a private-window crash. Record in a normal window.

9. **file://-served Chrome cannot list mic devices in-app:** confirmed on Chrome 150
   (2026-07-28) — `enumerateDevices()` returns blank ids and blank labels at every
   stage because file:// origins never persist a `getUserMedia` grant. Chrome's own
   per-capture permission pop-up (which also serves as its device picker) reappears
   once per recording; this is unavoidable and, as of v1.14, by design once
   `micEnumAnonymized` is set — DidaRec's own UI stops re-prompting once it's proven
   the environment can't deliver names. Serving the app over `http://localhost` (or
   any http(s) origin) restores persisted grants and the full named dropdown.

10. **Cut precision follows cluster size:** "Re-record from here" cuts at the
    last cluster boundary at/before the chosen time. Chrome's ~1s clusters
    give ~1s precision; Firefox's ~7.5s clusters mean the cut can land up to
    ~7.5s before the chosen point (extra re-recording — never surviving
    mistake content). Block-precision truncation inside the final kept
    cluster is the queued fix (REVIEW #22).

---

## Future features (roadmap)

- ~~**Webcam preview before recording**~~ — ✓ Done in v1.4
- **Screen switching mid-recording** — swap the screen source without stopping (browser picker interrupts briefly; produces black frames at the cut)
- **Black frame removal** — detect and trim black frames at stitch points (requires WebCodecs decode or canvas analysis)
- **mediabunny integration** — replace MediaRecorder with WebCodecs + mediabunny for MP4 output and streaming-to-disk (Cues/seeking no longer needs it — done zero-dependency in v1.8)
- **Trimming** — basic start/end trim before saving
- **Two-step tool** — separate lightweight video editor page for stitching, trimming, and cleanup (keeps the recorder simple)
- **User documentation** — README refresh (stale since v1.9's Firefox-first pass) + a faculty-facing usage guide; queued last so it documents the final feature set (REVIEW.md #19)
- ~~**Project name**~~ — ✓ Named **DidaRec** (part of DidaWorks) in v1.5

---

## File structure

```
screen-recorder/
├── index.html      # The entire app (HTML + CSS + JS, ~5700 lines)
├── README.md       # Project description and usage
├── LICENSE         # MIT License
├── BUILD_LOG.md    # This file
├── REVIEW.md       # Fable 5 code review — tracked items + build queue
└── test.cjs        # Node harness (126 scenarios / 812 assertions; npm i fake-indexeddb)
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

**Manual acceptance test (zero-prompt load + camera-only, v1.12 — Firefox primary):**
1. In a Firefox profile with no persisted camera/mic grants, load the page — zero
   permission prompts.
2. Click Webcam — exactly one camera prompt fires; the preview appears; the device
   label upgrades from generic ("Camera 1") to the real name once granted.
3. Reload the page — still zero prompts.
4. Click Screen off (leaving Webcam on) — camera-only mode, live preview visible,
   Record enabled; record a short clip, save, confirm it plays.
5. From the default state, click Screen off first — the app explains you need
   Webcam on first; click Webcam, then Screen off — camera-only reached correctly.
6. Repeat steps 1–2 in Chrome — no regression.

**Manual acceptance test (Firefox cancel/failed download, v1.9):**
1. In Firefox, set "Always ask you where to save files" (Settings → General → Downloads)
2. Record 10+ seconds, click "Stop & save", and CANCEL the save dialog
3. The confirmation bar appears; click "It didn't arrive — keep my recording"
4. Reload the page — the recovery banner must reappear, and "Recover & save" must
   produce a playable file
5. Repeat with a normal save; click "It's there — all set" — the session resolves
   (no banner on reload)

**Manual acceptance test (caption editor, v1.18 — the harness can't touch a real
DOM/video element; run in both Firefox (primary) and Chrome (secondary)):**

1. **Open video.** Click "Caption editor" while idle (not recording) →
   recorder controls hide, editor pane shows. Click "Open video", pick a
   `.webm` recorded earlier by this app → video loads with native controls,
   duration shown by the browser's own video chrome.
2. **Drag-and-drop.** Drag a `.webm` file from the OS file manager onto the
   editor pane (not through the file picker) → same result as #1.
3. **Add + edit a cue.** Play the video briefly, pause, click "Add caption"
   → a new row appears in the list, selected, with placeholder text; type
   real caption text and tab/click away (onchange commits) → the caption
   visibly appears on the video during that time range (live preview via the
   `<track>` element), confirming captions render live while editing, not
   just on export. **This is the only way to confirm the `track.track.mode`
   fix (review defect C) actually works** — the harness has no `TextTrack`
   object to assert against, so if captions don't visibly render here, that
   fix regressed.
3b. **Type while playing (regression check for review defect A).** Start
   playback, click "Add caption" partway through, and type a multi-word
   caption WITHOUT clicking away — keep typing as the video crosses into the
   NEXT cue's time range. Confirm: the row highlight moves to the new active
   cue, but the textarea you're still typing in keeps your uncommitted text
   and focus (does not blur, clear, or get replaced). This is the core
   transcribe-while-playing workflow.
3c. **Same-file re-pick (regression check for review defect F).** Import a
   caption file, then "Start fresh," then use "Import captions" again and
   pick the SAME file from the OS picker → it imports again (the button
   isn't dead). Repeat for "Open video" with the same `.webm` twice in a row.
4. **Seek-on-row-click.** Add 2–3 more cues at different times. Click a
   cue row (not its inputs) → video seeks to just inside that cue's start
   without starting playback.
5. **Time-edit validation.** Edit a cue's start time to something clearly
   invalid (e.g. "banana") → input reverts, a brief message appears,
   nothing else changes. Edit it to a valid time earlier than the previous
   cue → the row visibly reorders in the list. Edit a cue's end time to
   before its start → refused with the "end time needs to come after the
   start time" message, cue unchanged.
6. **Playback highlight.** Play the video through several cues → the
   currently-playing cue's row highlights, and the list scrolls to keep it
   in view, without janking on every video frame.
7. **Draft restore after reload.** Add/edit a few cues, wait ~1–2 seconds
   (autosave debounce), then reload the whole page and re-open the SAME
   video file → the "Saved caption edits found" banner appears; click
   "Continue editing them" → the edits are back exactly as left. Repeat,
   but click "Start fresh" instead → cues come back empty and reloading
   again shows no banner (draft was actually deleted).
8. **Import captions.** With a non-empty cue list, click "Import captions"
   and pick a `.vtt` or `.srt` file → a replace-confirmation banner appears
   (not a browser `confirm()` popup); confirming replaces the list and shows
   the "Imported N captions..." status line (with the partial-import caveat
   if the sample file has a deliberately malformed cue).
9. **Export naming + save.** Click "Save captions (.vtt)" on a video named
   e.g. `lecture-2026-07-29.webm` → the save dialog (Chrome/Edge) or download
   (Firefox) suggests/produces `lecture-2026-07-29.vtt`. Repeat with the
   ".srt" button → `lecture-2026-07-29.srt`. Open the saved file in a text
   editor to confirm it's well-formed WebVTT/SRT matching what was edited.
10. **Export cancel.** Click "Save captions (.vtt)" and cancel the save
    dialog (Chrome/Edge only) → no error banner, a quiet "cancelled" status
    note, and the draft is still restorable via #7's flow afterward.
11. **Recording guard.** Start a recording, then click "Caption editor" →
    refused with a plain-language message; the recorder UI is undisturbed
    and the recording keeps running.
12. **Back to recorder.** From the editor, click "Back to recorder" mid-edit
    → recorder controls reappear exactly as left (no stream/state
    disruption); a pending recovery banner (if one was showing before
    entering the editor) is still showing.
13. **Back to recorder during playback (regression check for review defect
    G).** Start the video playing, then click "Back to recorder" → the
    video's audio stops immediately (it's paused, not just hidden).
14. **Video-first guard (regression check for review defect H).** Open the
    caption editor fresh (no video opened yet) and click "Add caption" or
    "Import captions" → both refuse with "Open your video first — captions
    are saved with it." and create no cues.
15. **Draft banner doesn't leak stale rows (regression check for review
    defect E).** Open video A, add a couple of cues, then open video B which
    has its own saved draft from a prior session → the draft-restore banner
    for B appears with NO leftover rows from A visible behind it.

**Manual acceptance test (review pane / re-record, v1.20 — run in both browsers, Firefox first):**
1. **Stop & review.** Record ~30s, click "Stop & review" → recorder controls
   hide, pane shows, the preview plays and seeks; no save dialog appeared.
   Repeat from paused.
2. **Labels.** During the review stop the review button reads "Preparing
   review..." and "Stop & save" text is unchanged; back at the recorder,
   both labels are restored.
3. **Re-record from here.** Scrub mid-recording, click "Re-record from m:ss"
   → pane closes, "Kept m:ss…" status, "Undo re-record" visible. Record a
   new take, Stop & save → ONE stitched file that plays through the seam:
   a brief single-frame glitch at the seam is acceptable; multi-second
   freezes or silent audio gaps are NOT (v1.20's seam fix). Duration ≈
   kept + new take.  ✓ Passed in Firefox (owner, 2026-07-30).
4. **Undo.** After a cut, click "Undo re-record" → prior-segments status
   returns; record + save → the FULL original plus the new take (no cut
   applied).
5. **No-op cut.** With the playhead at the very end, "Re-record from here"
   → "That's already the end…" message; nothing changes.
6. **Start over.** "Re-record from 0:00" → confirm banner; "Keep reviewing"
   changes nothing; confirming discards and lands at clean idle (no
   recovery banner after reload).
7. **Save as is.** Single segment → normal save dialog/download; the file
   plays; reload shows no recovery banner.
8. **Cancel stays.** Cancel the save-as-is picker → still in the pane,
   "Save cancelled — your recording is still here."; saving again succeeds.
9. **Discard.** "Discard recording" → in-pane confirm renders correctly
   inside the pane; confirm → clean idle.
10. **Back to recorder.** → "N prior segment(s) preserved…" status; record
    + Stop & save → stitched file includes the reviewed content.
11. **Crash mid-review.** Kill the tab with the pane open → reload shows
    the recovery banner with the recording.
12. **Multi-segment.** Continue-recording chain → Stop & review → preview
    plays across seams; cut inside an EARLIER segment → later segment
    dropped; save → file contains exactly what was kept.
13. **Caption editor coexistence.** Caption editor still opens/closes
    normally before and after a review cycle.
14. **Degraded review (v1.20 hardening).** If a recording can't be scanned,
    the pane still opens with "Re-record from here" disabled and a plain
    message; Save as is / Discard / Back all still work. (Hard to trigger
    manually — covered by harness scenario DR; verify only if it occurs.)

**Manual acceptance test (v1.20.2 owner-acceptance fixes — both browsers):**
1. **Timer freeze.** Record ~30s, Stop & save → the elapsed display stops
   the instant you click, and stays frozen while the save dialog is being
   prepared. Same for Stop & review.
2. **Guard → Stop.** While recording, click "Caption editor" → the guard
   error appears; click Stop & save → the error disappears immediately,
   the timer freezes, and the save proceeds normally. (This is the re-test
   of the "Stop & save dead" report — if the save dialog genuinely never
   appears, open the console (F12) first and report what it shows.)
3. **Instant all-set.** Record a few minutes (bigger is better), crash the
   tab, recover via download, click "It's there — all set" → the banner
   clears and "All set" appears immediately (no multi-second freeze);
   reload → no recovery banner.
4. **Error dismiss.** Trigger any error (e.g. caption editor while
   recording) → the banner has a × that dismisses it.
5. **Caption hint.** Open the caption editor → the sidecar explanation
   line is visible under the export buttons and reads sensibly.

**Manual acceptance test (v1.21 recorder resilience — Firefox primary; the
failure it detects is the Firefox 153 silent recorder death):**
1. **Healthy start.** Record normally → "N chunks saved" climbs; no
   watchdog message ever appears during a normal record/stop/save cycle,
   including pauses longer than 12s (pause must never trigger the stall
   warning).
2. **Phantom start called out.** When Firefox is in its broken state
   (chunk counter never appears): within ~4s of clicking Record the app
   must abort on its own with "Recording couldn't start — Firefox's
   recorder failed silently…" and return to a usable idle (re-select
   screen + Record works). No phantom recording should ever run longer
   than ~4 seconds.
3. **Salvage on dead stop.** If a recording dies mid-way (or Firefox is
   broken mid-session): Stop & save must NEVER silently do nothing — it
   either saves what was captured or says plainly what's wrong. The
   9-item sequence from the v1.20.2 list item 2 (guard → Stop) should
   also still pass.
4. **Storage guidance (only if seen).** If the "Firefox's storage isn't
   responding" message ever appears at page load or save, note the
   circumstances — it means the (rarer) storage wedge, and restart
   guidance should be accurate.

**Manual acceptance test (block-precision cut, v1.22.1 — Firefox first,
then a Chrome spot-check):**
1. **Precision (the headline).** Record ~30s (mic on or off), Stop &
   review, scrub to a deliberate spot mid-recording (e.g. ~0:12) and note
   the exact time, click "Re-record from 0:12" → the "Kept 0:12" status
   must match the scrubbed time to within a second — NOT snapped down or
   up by ~7.5s (the old Firefox cluster granularity). Record a short new
   take, Stop & save → the file plays through the seam; the first take's
   content runs up to ~0:12 (within a frame or two), then the new take.
2. **Cut inside a long recording's later portion.** Same as 1 but scrub
   near the end of a ~1 min recording — precision holds anywhere, not
   just early.
3. **Undo still exact.** Cut mid-cluster → Undo re-record IMMEDIATELY
   (before recording) → record + save → the FULL original plus the new
   take (the refined marker cleared/restored exactly).
4. **Re-cut of a cut.** Cut at ~0:20, record a take, Stop & review, cut
   again EARLIER (~0:10) → save → content ends at ~0:10 + the newest
   take (the refinement of an already-cut segment stays consistent).
5. **Nothing else moved.** Save as is / Discard / Back to recorder /
   crash-recovery quick pass — all behave exactly as the #21 checklist
   verified (refinement touches only where the cut byte lands).
6. **Chrome spot-check.** Repeat 1 and 3 in Chrome (~1s → ~33ms is less
   dramatic but the "Kept" time should now match the scrub position
   almost exactly).

---

## Conventions for future agents

- **Zero-dependency philosophy:** Don't add npm packages or CDN scripts unless absolutely necessary. The single-file, zero-dependency architecture is a feature, not a constraint to work around. If a dependency is needed, document the trade-off.
- **Crash resilience is the core feature:** Any change to the recording pipeline must preserve the guarantee that a crash loses at most ~1 second of recording. Test crash scenarios after any pipeline change.
- **Faculty audience:** The user base is non-technical. UI should be self-explanatory. Error messages should suggest actions, not expose stack traces.
- **WebM streamable container:** Don't switch to standard MP4 (non-fragmented) — it requires end-of-file finalization that breaks crash resilience. Fragmented MP4 or WebM are the safe options.
- **File Edit Rule:** When working with Blue (the project owner), show proposed changes and wait for approval before writing. This is from the Aegis Framework standing instructions.
