# DidaRec

A free, open-source screen recorder by DidaWorks. Runs entirely in your browser — no account, no server, no watermark, no time limits.

**Crash-resilient by design:** Every second of your recording is saved to disk as it happens. If your browser crashes at minute 58 of a lecture, you lose about one second of video, because everything else is already saved.

## Features

- Record your screen, webcam, and microphone
- Webcam picture-in-picture overlay — draggable, resizable, with rectangle/square/circle shapes
- Pause and resume recording
- **Change screen while paused** — pause, pick a different screen or window to share, resume. The swap never gets recorded; the saved file plays as one continuous take
- Recording quality presets and microphone noise suppression
- Crash-resilient recording — survives browser crashes, tab closures, power loss
- Continue Recording — pick up where a crash left off and stitch segments automatically
- Automatic recovery of interrupted recordings on reopen
- **Review pane with take controls** — stop into a review screen instead of saving immediately, then:
  - **Redo last take** — one click discards your most recent segment and re-arms recording from right before it, so a botched take costs you nothing but the botched part
  - **Re-record from a point you scrub to**, or type a time (`m:ss`, like `1:30`, or `h:mm:ss` for longer recordings) and cut from there directly
  - Save as is, or discard the recording entirely
- **Caption editor** — open a saved `.webm` recording, add or import captions (`.vtt`/`.srt`), edit them against playback, and export a sidecar caption file. Captions are never burned into the video — they save as their own small file next to it, and the two travel together in the same folder (course sites and video players pick captions up automatically from a same-name file). Because it opens saved files, you save your recording first, then open it in the caption editor to caption it
- Camera and microphone device selection, with real device names shown once permission is granted
- Saves directly to your computer — no upload, no cloud
- Works in **Firefox** and **Chrome/Edge**

## How it works

Most screen recorders hold your entire recording in memory and only save it when you click Stop. That's why the horror stories all sound the same: an hour of recording, a crash, nothing to show for it.

DidaRec writes each second of video to persistent storage the moment it's recorded. There's nothing waiting in memory to lose.

## Browser support

DidaRec is built **Firefox-first** and supports both Firefox and Chrome/Edge fully. The two browsers save your recording differently, because they offer different browser APIs — this doesn't affect recording quality or crash resilience, only how the finished file lands on your disk.

- **Chrome/Edge:** uses the File System Access API. You pick the destination file up front (via `showSaveFilePicker`), and the recording streams straight to it as it's captured — the browser confirms the write for you.
- **Firefox:** doesn't implement that API, so DidaRec falls back to a normal browser download. Since a download's success can't be confirmed by the page, DidaRec shows a "Downloaded — did it arrive?" bar after saving; click "It's there — all set" once you've checked your Downloads folder, or "It didn't arrive — keep my recording" to keep it safely stored for another attempt.

Either way, the crash-resilience story is the same underneath: your data lives on disk in small pieces the whole time, and the save step just assembles/hands off what's already safe.

## System audio on Firefox

Firefox cannot capture your computer's system or tab audio from a web page — it currently ignores the browser's request for that audio track entirely (this is an upstream Firefox limitation, tracked publicly as Bugzilla bug 1541425, open since 2019). It isn't something DidaRec can work around from inside the app. DidaRec already asks for system audio every time you share a screen, so if Firefox ever ships support for this, recording system audio in Firefox will start working with no update to DidaRec needed.

Until then, here's how to get system audio into a Firefox recording:

**Route system audio in as your "microphone."** DidaRec already lets you pick which microphone to record, and a loopback input shows up in that same list looking just like a mic:

- **Windows "Stereo Mix"** — some sound drivers expose this built in (right-click the speaker icon → Sounds → Recording tab → enable Stereo Mix if you see it). If it's there, select it as your microphone in DidaRec.
- **VB-Audio Virtual Cable (VB-Cable)** — a free virtual loopback device if your driver doesn't offer Stereo Mix. Set your system output to the cable, then select the cable as your microphone in DidaRec.
- **Need your real mic AND system audio at the same time?** A simple loopback device can only carry one signal. Use **VoiceMeeter** (free) to mix your microphone and your system audio together into one virtual output, then select that mixed output as your "microphone" in DidaRec.

**Watch for echo.** If the loopback device is capturing the same audio you're actively listening to out loud (speakers, not headphones), your recording can pick up doubled or echoing sound. Fix it by listening on headphones, or by routing your monitoring through a different output than the one being looped back (VoiceMeeter handles this cleanly).

**Chrome/Edge don't need any of this.** When you share a screen or tab, tick "Also share audio" (or "Share tab audio," depending on what you're sharing) right in the browser's share picker, and DidaRec records it.

If a screen share ever lands with no audio, DidaRec shows a one-time reminder the first time it happens, worded for whichever browser you're using.

## Requirements

- Firefox 153 or newer (the version DidaRec is developed and tested against; earlier versions are untested), or Chrome/Edge 86+
- HTTPS (required for screen capture APIs) — use the hosted version or run locally with a dev server

## Usage

Use it right now at [bluebrazelton-dotcom.github.io/DidaRec](https://bluebrazelton-dotcom.github.io/DidaRec/), or clone [the repo](https://github.com/bluebrazelton-dotcom/DidaRec) and serve it locally.

## License

MIT — see [LICENSE](LICENSE).

## Part of DidaWorks

DidaRec is part of the DidaWorks productivity suite.
