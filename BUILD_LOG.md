# Screen Recorder — Build Log

*For handoff to future agents (Fable 5 review, etc.). Documents every version, decision, bug, and architectural choice.*

---

## Project overview

A free, open-source, browser-based screen recorder for faculty. Single HTML file, zero dependencies (v1). Crash-resilient by design: every second of recording is saved to disk as it happens via IndexedDB. If the browser crashes, the recording survives.

**Repo:** github.com/bluebrazelton-dotcom/screen-recorder
**License:** MIT
**Target browsers:** Chrome 86+, Edge 86+ (requires File System Access API + getDisplayMedia)
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

## Known limitations

1. **Memory usage during stitching:** All segment blobs are loaded into memory for concatenation. For very long recordings (multiple hours), this could hit browser memory limits. Future improvement: stream-based stitching.

2. **No seeking in output:** MediaRecorder-produced WebM files lack a Cues element (seek index), so players can't seek precisely. This affects both single and stitched recordings. Fix would require writing Cues at save time.

3. **WebM only:** No MP4 output. Some platforms (iOS, older Android) have limited WebM support. mediabunny could add MP4 output in a future version.

4. **Timestamp estimation:** When stitching, the duration of each segment is estimated as `lastClusterTimestamp + 1000ms` (one cluster duration). This could produce a tiny gap or overlap at the stitch point. Imperceptible in practice but technically imprecise.

5. **No black frame detection:** Screen switching mid-recording produces a few black frames. Detecting and removing these would require frame-by-frame analysis (decode → inspect → re-encode), which is a significant complexity increase. Noted for future exploration.

6. **Single-file architecture:** The entire app is one HTML file with inline CSS and JS. This is intentional (zero build step, easy to deploy), but limits code organization as features grow. Consider splitting if the file exceeds ~2000 lines.

---

## Future features (roadmap)

- **Webcam preview before recording** — show camera feed in canvas during the Select Screen / pre-record phase
- **Screen switching mid-recording** — swap the screen source without stopping (browser picker interrupts briefly; produces black frames at the cut)
- **Black frame removal** — detect and trim black frames at stitch points (requires WebCodecs decode or canvas analysis)
- **mediabunny integration** — replace MediaRecorder with WebCodecs + mediabunny for MP4 output, streaming-to-disk, and proper Cues/seeking
- **Trimming** — basic start/end trim before saving
- **Two-step tool** — separate lightweight video editor page for stitching, trimming, and cleanup (keeps the recorder simple)
- **Project name** — still using "screen-recorder" as working name; final name deferred

---

## File structure

```
screen-recorder/
├── index.html      # The entire app (HTML + CSS + JS, ~1500 lines)
├── README.md       # Project description and usage
├── LICENSE         # MIT License
└── BUILD_LOG.md    # This file
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

---

## Conventions for future agents

- **Zero-dependency philosophy:** Don't add npm packages or CDN scripts unless absolutely necessary. The single-file, zero-dependency architecture is a feature, not a constraint to work around. If a dependency is needed, document the trade-off.
- **Crash resilience is the core feature:** Any change to the recording pipeline must preserve the guarantee that a crash loses at most ~1 second of recording. Test crash scenarios after any pipeline change.
- **Faculty audience:** The user base is non-technical. UI should be self-explanatory. Error messages should suggest actions, not expose stack traces.
- **WebM streamable container:** Don't switch to standard MP4 (non-fragmented) — it requires end-of-file finalization that breaks crash resilience. Fragmented MP4 or WebM are the safe options.
- **File Edit Rule:** When working with Blue (the project owner), show proposed changes and wait for approval before writing. This is from the Aegis Framework standing instructions.
