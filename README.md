# DidaRec

A free, open-source screen recorder by DidaWorks. Runs entirely in your browser — no account, no server, no watermark, no time limits.

**Crash-resilient by design:** Every second of your recording is saved to disk as it happens. If your browser crashes at minute 58 of a lecture, you lose about one second of video, because everything else is already saved.

## Features

- Record your screen, webcam, and microphone
- Webcam picture-in-picture overlay — draggable, resizable, with rectangle/square/circle shapes
- Crash-resilient recording — survives browser crashes, tab closures, power loss
- Continue Recording — pick up where a crash left off and stitch segments automatically
- Automatic recovery of interrupted recordings on reopen
- Camera and microphone device selection
- Saves directly to your computer — no upload, no cloud
- Works in Chrome and Edge on Windows

## How it works

Most screen recorders hold your entire recording in memory and only save it when you click Stop. That's why the horror stories all sound the same: an hour of recording, a crash, nothing to show for it.

DidaRec writes each second of video to persistent storage the moment it's recorded. There's nothing waiting in memory to lose.

## Requirements

- Chrome 86+ or Edge 86+ (File System Access API required)
- HTTPS (required for screen capture APIs) — use the hosted version or run locally with a dev server

## Usage

Visit the hosted version at [your-github-pages-url] or clone and serve locally.

## License

MIT — see [LICENSE](LICENSE).

## Part of DidaWorks

DidaRec is part of the DidaWorks productivity suite.
