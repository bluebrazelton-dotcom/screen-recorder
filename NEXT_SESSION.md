# DidaRec — Next Session, Start Here

Close-out snapshot, 2026-07-29 (post-v1.14, pending commit). An Aegis session also has
the fuller `project_screen_recorder.md` project memory — read that too if available.

## Where things stand

- **v1.14 is done, pending commit.** This session ran in a sandboxed scratch copy of
  the repo (see Gotchas below) — the owner commits from a normal shell. v1.14 is the
  mic device selection overhaul that fixes the interference/no-voice bug found during
  v1.13's Chrome acceptance: an early `primeMicLabels()` grant path (gesture-gated,
  so zero-prompts-at-load still holds), blank-id placeholder options removed, an
  anonymized-re-enumeration guard, a persistent `micEnumAnonymized` verdict so DidaRec
  stops re-prompting once an environment has proven it can't deliver names, an honest
  Default-option placeholder, and `captureMic` surfacing the granted track's own
  label. Full write-up in `BUILD_LOG.md`; closes REVIEW.md #15 and this file's old
  queue item 1.
- v1.13 (streaming multi-segment stitch) is committed and pushed (`20b3ea8`) and
  unaffected by this session — v1.14 touched enumeration/selection UI only, never the
  recording or save pipeline.
- Harness: 67 scenarios / 392 assertions (new AY–BK this session). `node test.cjs`
  prints the assertion total, not a scenario count — see Gotchas.
- Real acceptance (owner, both browsers, 2026-07-29): **Chrome** — zero prompts from
  the mic dropdown or toggle; only the platform's own record-start permission pop-up
  remains (it doubles as the mic picker in file:// Chrome); "Microphone: <device>"
  shown correctly during recording; real voice on playback. **Firefox** — full named
  dropdown works end to end, no regressions.
- Standing preference (in Aegis memory too): run DidaRec work as orchestrator +
  Sonnet 5 subagents (`Agent` tool, `model: "sonnet"`) — Fable plans/reviews/
  presents, Sonnet drafts/explores/runs tests in a scratch copy. The File Edit
  Rule still applies at the orchestrator level. This session ran exactly that way,
  iteratively: an initial fix, then two owner field reports (a re-prompt loop, then a
  lingering nag even after the environment had already been proven incapable) each
  drove one more correction pass in the same scratch copy before acceptance passed.
- Standing lesson from 07-23 (three bugs caught ONLY in a real browser), reconfirmed
  07-28/07-29: the harness proves logic; only a browser proves pixels — and now, only
  a browser proves audio, and only the owner's actual machine proves what a specific
  permission environment (file://, a specific Chrome build, a specific Bluetooth
  headset) actually does. This session's real root cause needed an owner-run
  diagnostic the harness could never have produced by itself. Never skip the browser
  pass.

## Permanent platform knowledge (not a bug — read before touching mic code again)

- **file://-served Chrome cannot list mic devices in-app, ever.** Confirmed Chrome
  150, 2026-07-28: `enumerateDevices()` returns a blank deviceId AND a blank label at
  every stage — pre-grant, during a live granted stream, after the stream stops, and
  on a second grant. This is because file:// origins never persist a `getUserMedia`
  grant. Chrome's own per-capture permission pop-up is the only working device
  picker in this environment, and it reappears once per recording by design — that
  is expected platform behavior, not a regression to chase. `micEnumAnonymized` in
  `localStorage` (set by v1.14) records the verdict so DidaRec's own UI stops
  re-prompting once this is proven. Serving the app over `http://localhost` (or any
  http(s) origin) restores persisted grants and the full named in-app dropdown.
- **The original "interference" was a Bluetooth headset's hands-free profile.** With
  mic selection inert (the pre-v1.14 bug), Chrome fell back to `Headset (T9
  Hands-Free AG Audio) (Bluetooth)` — 8–16 kHz telephony-band audio, which is what
  sounded like "interference." Firefox happened to default to the real mic, which is
  why Firefox "worked" throughout v1.9–v1.13. If a future session hears
  "interference" or "no voice" again, check which physical device is actually
  granted before assuming a new capture regression.

## Read first

- `BUILD_LOG.md` — architecture + full version history (through v1.14).
- `REVIEW.md` — the build queue and what's fixed.
- `test.cjs` — Node harness (67 scenarios / 392 assertions). `npm i fake-indexeddb`
  then `node test.cjs`. Extend it; don't bypass it.
- `STREAMING_STITCH_HANDOFF.md` / `STREAMING_SAVE_HANDOFF.md` — how the v1.11/v1.13
  passes were run (untracked working docs; predate the mic work).

## Ground rules (unchanged)

Zero dependencies, single `index.html`, no build step. WebM / streamable only. Don't
touch the recording pipeline (~1s-max-loss crash guarantee) or the v1.11/v1.13
streamed save flows. Firefox is the primary browser — test there, not just Chrome.
Faculty audience: messages suggest an action, never a stack trace. Show Blue every
proposed change in full and wait for approval before writing any file. End with a
working page; bump the version in `BUILD_LOG.md` and update `REVIEW.md` when done.

## Open queue (priority order)

1. Tier 1: caption editor with VTT/SRT import/export (highest-value open item — ADA
   Title II; prior-art recon: borrow laubonghaudoi/subtitle-editor, MIT), chapter-
   marker hotkeys, sidecar export convention. The caption editor deserves its own
   brief and likely multiple sessions.

## Gotchas (learned the hard way)

- Don't run index-touching git (`status`/`add`/`commit`) from a restricted sandbox —
  stale `.git/index.lock` blocks later git; read-only checks there, real git in a
  normal shell. (Blue's machine once had a stale `.git/HEAD.lock` from an interrupted
  git — same cure: `rm` it.)
- Staging can serve a stale copy — confirm with a fresh shell read.
- `.gitignore` covers `node_modules/`, `_to_delete/`, `*.webm`, `*_HANDOFF.md`,
  `*_completion_report.md`.
- Scenario-count bookkeeping drifts (earlier docs said "37 scenarios" when there
  were 46 labels) — the assertion total from `node test.cjs` is ground truth;
  count `await scenario(` calls if you need the scenario number.
