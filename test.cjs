'use strict';
const vm = require('vm');
const fs = require('fs');
require('fake-indexeddb/auto'); // registers globalThis.indexedDB in the main realm
const gidb = globalThis.indexedDB;

// ---------- shared spies / captures ----------
let lastWritten = [];     // one combined Blob per SAVED FILE (pushed on close())
let writeCalls = [];      // every individual write() payload, across files
let abortCalls = 0;       // writable.abort() invocations
let closedFiles = 0;      // writable.close() invocations
let failWriteAfter = -1;  // >=0: the FSA mock throws on the Nth write() call
let recordedErrors = [];
let statusHistory = [];   // every updateStatus() text, in order
let objectUrlBlobs = [];  // every Blob handed to URL.createObjectURL (downloads)
let rafQueue = [];
let rafId = 0;
let addChunkCalls = 0;
let downloadClicks = [];
let getUserMediaCalls = []; // every getUserMedia(constraints) call, for permission-prompt assertions
let mockDevices = [];       // controllable enumerateDevices() result for label-upgrade tests
let localStorageStore = {}; // real in-memory backing for the localStorage mock below —
                             // a no-op stub can't verify the micEnumAnonymized flag's persistence

// ---------- DOM / platform mocks ----------
const ctxStub = new Proxy({}, {
  get: (t, p) => (p in t ? t[p] : () => {}),
  set: (t, p, v) => { t[p] = v; return true; },
});

function makeStream(tracks) {
  tracks = tracks || [];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(t => t.kind !== 'audio'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    addEventListener() {},
  };
}
function makeEl(id) {
  const cls = new Set();
  const children = [];
  const _handlers = {};
  let defaultOpt = null; // the single <option value="...">text</option> baked into an innerHTML reset — tracked separately from `children` (see innerHTML setter) so querySelectorAll('option[value]')'s count keeps meaning "real, appended options" for every existing scenario, while applyDeviceDefaultText() can still find and retext it.
  return {
    id, style: {}, _cls: cls, _handlers,
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : f; on ? cls.add(c) : cls.delete(c); },
      contains: (c) => cls.has(c),
    },
    set textContent(v) { this._t = v; }, get textContent() { return this._t || ''; },
    set className(v) { this._cn = v; }, get className() { return this._cn || ''; },
    set disabled(v) { this._d = v; }, get disabled() { return this._d; },
    set value(v) { this._v = v; }, get value() { return this._v || ''; },
    // innerHTML clears tracked children — matches real DOM semantics closely enough
    // for the dropdown-rebuild pattern enumerateDevices() uses (clear then appendChild).
    // Also parses out the single default-option literal enumerateDevices() resets
    // with (e.g. '<option value="">Default microphone</option>') into `defaultOpt`,
    // mirroring what a real browser's HTML parser would do — but kept out of
    // `children` so querySelectorAll('option[value]') still counts only real options.
    set innerHTML(v) {
      this._h = v; children.length = 0;
      const m = /^<option value="([^"]*)">([^<]*)<\/option>$/.exec(v);
      defaultOpt = m ? { value: m[1], _t: m[2], get textContent() { return this._t; }, set textContent(t) { this._t = t; } } : null;
    },
    get innerHTML() { return this._h || ''; },
    set srcObject(v) { this._s = v; }, get srcObject() { return this._s; },
    appendChild(child) { children.push(child); return child; },
    removeChild(child) { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); },
    // Minimal selector support: only what enumerateDevices() needs —
    // option[value] / option[value="X"] over appended children, plus the
    // parsed-out defaultOpt for option[value=""] specifically.
    querySelector(sel) {
      const m = /^option\[value(?:="([^"]*)")?\]$/.exec(sel);
      if (!m) return null;
      if (m[1] !== undefined) {
        if (m[1] === '' && defaultOpt) return defaultOpt;
        return children.find(c => c.value === m[1]) || null;
      }
      return children.find(c => c.value !== undefined) || null;
    },
    querySelectorAll(sel) {
      return /^option\[value\]$/.test(sel) ? children.filter(c => c.value !== undefined) : [];
    },
    click() {},
    // Same registration pattern as navigator.mediaDevices._handlers below —
    // stored per event type so a scenario can fire the exact listener a
    // real dispatchEvent would invoke, without a real DOM event system.
    addEventListener(type, fn) { (_handlers[type] = _handlers[type] || []).push(fn); },
    removeEventListener() {},
    getContext() { return ctxStub; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
    captureStream() { return makeStream([{ kind: 'video', stop() {} }]); },
    play() { return Promise.resolve(); },
    get readyState() { return 4; },
    width: 1280, height: 720, videoWidth: 640, videoHeight: 480, muted: false, playsInline: false,
  };
}

const _elCache = {};
const _docHandlers = {};
const documentMock = {
  hidden: false,
  getElementById: (id) => (_elCache[id] || (_elCache[id] = makeEl(id))),
  createElement: (tag) => { const el = makeEl(tag); if (tag === 'a') { el.click = () => { downloadClicks.push(el.download); }; } return el; },
  addEventListener: (type, fn) => { (_docHandlers[type] = _docHandlers[type] || []).push(fn); },
  removeEventListener() {},
  body: { appendChild() {}, removeChild() {} },
};
function dispatchDoc(type) { (_docHandlers[type] || []).forEach(fn => fn({})); }

const windowMock = { addEventListener() {}, removeEventListener() {} };

class MediaRecorderMock {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; this._stopCalls = 0; }
  start() { this.state = 'recording'; }
  stop() { this._stopCalls++; this.state = 'inactive'; if (this.onstop) return this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
}
class WorkerMock {
  constructor(url) { this.url = url; this._started = false; this._terminated = false; this._onmessage = null; }
  set onmessage(fn) { this._onmessage = fn; }
  get onmessage() { return this._onmessage; }
  postMessage(m) { if (m && m.type === 'start') this._started = true; else if (m && m.type === 'stop') this._started = false; }
  terminate() { this._terminated = true; }
}
class MediaStreamMock {
  constructor(tracks) { this._t = tracks || []; }
  getTracks() { return this._t; }
  getVideoTracks() { return this._t.filter(t => t.kind !== 'audio'); }
  getAudioTracks() { return this._t.filter(t => t.kind === 'audio'); }
}
class AudioContextMock {
  createMediaStreamDestination() { return { stream: makeStream([]) }; }
  createMediaStreamSource() { return { connect() {} }; }
  close() { return Promise.resolve(); }
}

const sandbox = {
  console, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
  indexedDB: gidb,
  IDBKeyRange: globalThis.IDBKeyRange,   // used by the streamed save's chunk cursor
  document: documentMock,
  window: windowMock,
  navigator: { mediaDevices: {
    _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    getUserMedia: async (c) => { getUserMediaCalls.push(c); return makeStream([{ kind: 'video', stop() {} }, { kind: 'audio', stop() {} }]); },
    getDisplayMedia: async () => makeStream([{ kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {}, stop() {} }]),
    enumerateDevices: async () => mockDevices,
  } },
  localStorage: {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: (k) => { delete localStorageStore[k]; },
  },
  URL: { createObjectURL: (b) => { objectUrlBlobs.push(b); return 'blob:mock'; }, revokeObjectURL: () => {} },
  requestAnimationFrame: (cb) => { rafId++; rafQueue.push({ id: rafId, cb }); return rafId; },
  cancelAnimationFrame: (id) => { rafQueue = rafQueue.filter(x => x.id !== id); },
  MediaRecorder: MediaRecorderMock,
  Worker: WorkerMock,
  MediaStream: MediaStreamMock,
  AudioContext: AudioContextMock,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

// ---------- load script (extract the <script> block from index.html in this folder) ----------
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.log('FATAL: no <script> block found in index.html'); process.exit(2); }
let code = scriptMatch[1];
code += '\n;globalThis.__api = { state, pipState, createSession, addChunk, deleteSession, finalizeRecording, stitchAndSave, recoverRecording, startRecording, startCompositing, stopCompositing, startDrawClock, parseCaptionTimestamp, formatCaptionTimestamp, parseVTT, parseSRT, detectCaptionFormat, serializeVTT, serializeSRT };';
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app_new.js' });
const api = sandbox.__api;
const state = api.state;
// Snapshot state.sources' true script-load default before any scenario gets
// a chance to mutate the (shared, never-reset-by-resetState) live object —
// scenarios below freely reassign state.sources, so reading it later would
// only prove what the last scenario left behind, not what index.html ships.
const INITIAL_SOURCES_MIC = state.sources.mic;
const ORIG = {
  addChunk: sandbox.addChunk, concatenateWebM: sandbox.concatenateWebM,
  getUserMedia: sandbox.navigator.mediaDevices.getUserMedia,
  mdEnumerateDevices: sandbox.navigator.mediaDevices.enumerateDevices,
};
sandbox.showError = (m) => { recordedErrors.push(m || ''); };
const ORIG_updateStatus = sandbox.updateStatus;
sandbox.updateStatus = (mode, text) => { statusHistory.push(text); return ORIG_updateStatus(mode, text); };
const ORIG_CARRY_CAP = sandbox.STREAM_CARRY_CAP;

// ---------- helpers ----------
function flushRaf() { const q = rafQueue; rafQueue = []; for (const { cb } of q) cb(16); }
const drain = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function resetDB() { return new Promise((res) => { const r = gidb.deleteDatabase('screen-recorder-db'); r.onsuccess = r.onerror = r.onblocked = () => res(); }); }
function dispatchDeviceChange() { (sandbox.navigator.mediaDevices._handlers.devicechange || []).forEach(fn => fn({})); }
function dispatchEl(id, type) { (documentMock.getElementById(id)._handlers[type] || []).forEach(fn => fn({})); }
function readStore(name) {
  return new Promise((resolve) => {
    const req = gidb.open('screen-recorder-db');
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) { const s = db.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] }); s.createIndex('bySession', 'sessionId', { unique: false }); }
    };
    req.onsuccess = () => { const db = req.result; let tx; try { tx = db.transaction(name, 'readonly'); } catch (e) { db.close(); return resolve([]); } const g = tx.objectStore(name).getAll(); g.onsuccess = () => { const r = g.result; db.close(); resolve(r); }; g.onerror = () => { db.close(); resolve([]); }; };
    req.onerror = () => resolve([]);
  });
}
async function seed(nChunks, mime) {
  mime = mime || 'video/webm;codecs=vp9,opus';
  const id = await api.createSession(mime);
  for (let i = 0; i < nChunks; i++) await api.addChunk(id, i, new Blob(['x']));
  return id;
}
// The FSA mock models FILES, not write() calls: each writable collects its
// parts and pushes ONE combined Blob to lastWritten when close() resolves — so
// "lastWritten.length" means "files written" whether a save streamed in many
// writes (v1.11) or arrived as a single blob. Individual payloads land in
// writeCalls; abort() is counted; failWriteAfter injects a mid-write failure.
function pickerSequence(outcomes) {
  let i = 0;
  return async () => {
    const o = outcomes[Math.min(i, outcomes.length - 1)]; i++;
    if (o === 'abort') { const e = new Error('abort'); e.name = 'AbortError'; throw e; }
    return { createWritable: async () => {
      const parts = [];
      return {
        write(b) {
          if (failWriteAfter >= 0 && writeCalls.length >= failWriteAfter) throw new Error('disk error');
          writeCalls.push(b);
          parts.push(b);
        },
        close() { lastWritten.push(new Blob(parts)); closedFiles++; },
        abort() { abortCalls++; },
      };
    } };
  };
}
async function resetState() {
  await resetDB();
  Object.assign(state, { sessionId: null, chunkIndex: 0, recording: false, paused: false, mediaRecorder: null, screenStream: null, cameraStream: null, micStream: null, heldMicStream: null, heldMicDeviceId: null, audioContext: null, compositeStream: null, drawFrame: null, drawWorker: null, drawWorkerUrl: null, animFrameId: null, priorSegments: [], lastMicLabel: null, lastCameraLabel: null });
  windowMock._recoverySessions = null; windowMock._recoverySessionId = null; windowMock._recoveryMimeType = null;
  delete windowMock.showSaveFilePicker;   // absent = Firefox mode; FSA scenarios set their own picker
  sandbox.addChunk = ORIG.addChunk; sandbox.concatenateWebM = ORIG.concatenateWebM;
  sandbox.navigator.mediaDevices.getUserMedia = ORIG.getUserMedia;
  sandbox.navigator.mediaDevices.enumerateDevices = ORIG.mdEnumerateDevices;
  sandbox.micHoldInFlight = false;
  sandbox.downloadPendingIds = [];
  sandbox.downloadPendingFiles = 0;
  sandbox.stitchFallbackSegments = null;
  documentMock.getElementById('downloadConfirm').classList.remove('visible');
  documentMock.getElementById('recoveryBanner').classList.remove('visible');
  documentMock.getElementById('stitchFallback').classList.remove('visible');
  documentMock.hidden = false;
  lastWritten = []; recordedErrors = []; rafQueue = []; addChunkCalls = 0; downloadClicks = [];
  writeCalls = []; abortCalls = 0; closedFiles = 0; failWriteAfter = -1;
  statusHistory = []; objectUrlBlobs = [];
  getUserMediaCalls = []; mockDevices = [];
  localStorageStore = {};
  sandbox.STREAM_CARRY_CAP = ORIG_CARRY_CAP;
}

// ---------- assertions ----------
let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.log('  ✗ ' + msg); } }
async function scenario(name, fn) {
  await resetState();
  process.stdout.write('• ' + name + '\n');
  try { await fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + (e && e.stack || e)); }
}

(async () => {
  if (typeof sandbox.addChunk !== 'function' || typeof sandbox.finalizeRecording !== 'function') {
    console.log('FATAL: script functions not exposed on global; harness assumptions wrong'); process.exit(2);
  }

  // A — cancel keeps the recording (single-segment finalize)
  await scenario('A cancel-save preserves single recording', async () => {
    const id = await seed(2);
    state.sessionId = id; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['abort']);
    await api.finalizeRecording();
    await drain();
    const sessions = await readStore('sessions');
    const chunks = await readStore('chunks');
    assert(sessions.length === 1, 'session kept after cancel (got ' + sessions.length + ')');
    assert(chunks.length === 2, 'chunks kept after cancel (got ' + chunks.length + ')');
    assert(recordedErrors.some(m => /still here|preserved|recover/i.test(m)), 'user told recording is safe');
  });

  // B — successful save deletes the recording
  await scenario('B successful save deletes session', async () => {
    const id = await seed(2);
    state.sessionId = id; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    const sessions = await readStore('sessions');
    const chunks = await readStore('chunks');
    assert(sessions.length === 0, 'session deleted after save (got ' + sessions.length + ')');
    assert(chunks.length === 0, 'chunks deleted after save (got ' + chunks.length + ')');
    assert(lastWritten.length === 1 && lastWritten[0].size === 2, 'wrote a 2-byte blob (got ' + (lastWritten[0] && lastWritten[0].size) + ')');
  });

  // C — stitchAndSave cancel keeps ALL segments
  await scenario('C stitch cancel preserves all segments', async () => {
    const p1 = await seed(2), p2 = await seed(2), cur = await seed(2);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }, { sessionId: p2, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['abort']);
    await api.finalizeRecording();
    await drain();
    const sessions = await readStore('sessions');
    assert(sessions.length === 3, 'all 3 sessions kept after stitch cancel (got ' + sessions.length + ')');
    assert(state.priorSegments.length === 2, 'priorSegments untouched after cancel');
  });

  // D — stitchAndSave success deletes all segments
  // BEHAVIOR CHANGE (STREAMING_STITCH_HANDOFF §3.4): the streamed stitch bails
  // to the in-app fallback banner on unparseable segments instead of
  // raw-concatenating them, so this scenario's original 1-byte seed('x')
  // chunks no longer exercise the success path (pass 1 bails on them). Reseeded
  // with real WebM fixtures (seedSegments) so the original bookkeeping
  // assertion — one write, delete-all, priorSegments cleared — still tests the
  // save-success intent, just through the streamed stitch.
  await scenario('D stitch success deletes all segments', async () => {
    const [p1, p2, cur] = await seedSegments([syntheticWebm(), syntheticWebm(), syntheticWebm()]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }, { sessionId: p2, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'all sessions deleted after stitch save (got ' + sessions.length + ')');
    assert(state.priorSegments.length === 0, 'priorSegments cleared');
    assert(lastWritten.length === 1, 'one stitched file written');
  });

  // E — recovery, stitch BAILS (unparseable segments), cancel on 2nd part ->
  // only written part deleted.
  // BEHAVIOR CHANGE: recoverRecording no longer calls concatenateWebM at all
  // (it goes straight to the streamed stitch), so the forced-throw stub is
  // inert — removed. These 1-byte seed('x') chunks aren't valid WebM, so pass
  // 1 bails exactly like a real unparseable chain would, driving the same
  // parts fallback the old thrown-stitch catch used to. The bail itself costs
  // one picker call (the doomed stitch attempt's own picker, consumed before
  // pass 1 ever runs) — pickerSequence gets a leading 'ok' to account for it.
  await scenario('E recovery stitch-bail saves parts, deletes only written', async () => {
    const s1 = await seed(2), s2 = await seed(2), s3 = await seed(2);
    windowMock._recoverySessions = [{ id: s1, mimeType: 'video/webm' }, { id: s2, mimeType: 'video/webm' }, { id: s3, mimeType: 'video/webm' }];
    windowMock.showSaveFilePicker = pickerSequence(['ok', 'ok', 'abort']); // stitch attempt bails, part1 saves, part2 cancels
    await api.recoverRecording();
    await drain();
    const sessions = await readStore('sessions');
    const ids = sessions.map(s => s.id);
    assert(!ids.includes(s1), 's1 deleted (was written)');
    assert(ids.includes(s2) && ids.includes(s3), 's2 & s3 preserved (not written)');
    assert(lastWritten.length === 1, 'exactly one part written before cancel (got ' + lastWritten.length + ')');
    assert(recordedErrors.some(m => /separate file/i.test(m)), 'told parts saved separately');
  });

  // E2 — recovery, stitch BAILS, all parts save -> all deleted.
  // Same bail-not-throw change as E; the stub is inert here too and removed.
  // pickerSequence(['ok']) already covers the extra leading picker call (every
  // outcome after the sequence is exhausted repeats the last one).
  await scenario('E2 recovery stitch-bail all-save deletes all', async () => {
    await seed(2); await seed(2); // ids captured via recovery list below
    const all = await readStore('sessions');
    windowMock._recoverySessions = all.map(s => ({ id: s.id, mimeType: 'video/webm' }));
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.recoverRecording();
    await drain();
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'all parts deleted after separate saves (got ' + sessions.length + ')');
    assert(lastWritten.length === 2, 'two separate part files written (got ' + lastWritten.length + ')');
  });

  // F — recovery, stitch SUCCEEDS, cancel -> keep all
  await scenario('F recovery stitch-success cancel keeps all', async () => {
    await seed(2); await seed(2);
    const all = await readStore('sessions');
    windowMock._recoverySessions = all.map(s => ({ id: s.id, mimeType: 'video/webm' }));
    windowMock.showSaveFilePicker = pickerSequence(['abort']);
    await api.recoverRecording();
    await drain();
    const sessions = await readStore('sessions');
    assert(sessions.length === 2, 'both segments kept after recovery cancel (got ' + sessions.length + ')');
  });

  // G — chunk-write failure stops recorder, saves what we have, quota message
  await scenario('G chunk-write failure -> stop + finalize + quota msg', async () => {
    state.sources = { screen: true, camera: false, mic: false };
    state.screenStream = makeStream([{ kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {}, stop() {} }]);
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    sandbox.addChunk = async (sid, idx, blob) => { addChunkCalls++; if (addChunkCalls >= 4) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return ORIG.addChunk(sid, idx, blob); };
    await api.startRecording();
    const rec = state.mediaRecorder;
    assert(!!rec, 'recorder created');
    for (let i = 0; i < 4; i++) rec.ondataavailable({ data: new Blob(['x']) });
    await drain();
    rec.ondataavailable({ data: new Blob(['x']) }); // 5th, after failure — must be ignored
    await drain();
    assert(rec._stopCalls >= 1, 'recorder was stopped on write failure');
    assert(addChunkCalls === 4, 'no chunks attempted after failure (got ' + addChunkCalls + ')');
    assert(recordedErrors.some(m => /storage full/i.test(m)), 'plain-language storage-full message');
    assert(lastWritten.length === 1 && lastWritten[0].size === 3, 'saved the 3 good chunks (got ' + (lastWritten[0] && lastWritten[0].size) + ')');
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'session saved+deleted after graceful stop (got ' + sessions.length + ')');
  });

  // H — draw clock switches rAF <-> worker on visibility
  await scenario('H draw clock switches rAF/worker on visibility', async () => {
    state.screenStream = makeStream([{ kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), stop() {} }]);
    documentMock.hidden = false;
    api.startCompositing();
    assert(typeof state.drawFrame === 'function', 'drawFrame set by startCompositing');
    assert(rafQueue.length === 1 && !state.drawWorker, 'visible -> rAF scheduled, no worker');
    let ticks = 0; state.drawFrame = () => { ticks++; };
    flushRaf();
    assert(ticks === 1, 'rAF drove one draw (got ' + ticks + ')');
    // go hidden
    documentMock.hidden = true; dispatchDoc('visibilitychange');
    assert(!!state.drawWorker && state.drawWorker._started, 'hidden -> worker started');
    state.drawWorker._onmessage(); // simulate worker tick
    assert(ticks === 2, 'worker drove one draw (got ' + ticks + ')');
    // back to visible
    documentMock.hidden = false; dispatchDoc('visibilitychange');
    assert(state.drawWorker && state.drawWorker._started === false, 'visible again -> worker stopped');
    assert(rafQueue.length >= 1, 'visible again -> rAF rescheduled');
    api.stopCompositing();
    assert(state.drawFrame === null && state.drawWorker === null, 'stopCompositing tears down clock');
    if (state.timerInterval) clearInterval(state.timerInterval);
  });

  // I — quality selector controls video bitrate
  await scenario('I quality selector controls video bitrate', async () => {
    state.sources = { screen: true, camera: false, mic: false };
    state.screenStream = makeStream([{ kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {}, stop() {} }]);
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    documentMock.getElementById('qualitySelect').value = '800000';
    await api.startRecording();
    const rec = state.mediaRecorder;
    assert(rec && rec.opts.videoBitsPerSecond === 800000, 'videoBitsPerSecond from selector (got ' + (rec && rec.opts.videoBitsPerSecond) + ')');
    assert(rec && rec.opts.audioBitsPerSecond === 128000, 'audioBitsPerSecond capped at 128k (got ' + (rec && rec.opts.audioBitsPerSecond) + ')');
    if (rec && rec.state !== 'inactive') rec.stop();
    await drain();
    if (state.timerInterval) clearInterval(state.timerInterval);
  });

  // J — canvas resolution capped at 1080p on large screens
  await scenario('J canvas capped at 1080p on large screens', async () => {
    const cv = documentMock.getElementById('previewCanvas');
    const cases = [[3840, 2160, 1920, 1080], [2560, 1440, 1920, 1080], [1920, 1080, 1920, 1080], [1280, 720, 1280, 720]];
    for (const [w, h, ew, eh] of cases) {
      state.screenStream = makeStream([{ kind: 'video', getSettings: () => ({ width: w, height: h }), stop() {} }]);
      api.startCompositing();
      assert(cv.width === ew && cv.height === eh, w + 'x' + h + ' -> ' + cv.width + 'x' + cv.height + ' (want ' + ew + 'x' + eh + ')');
      api.stopCompositing();
    }
    if (state.timerInterval) clearInterval(state.timerInterval);
  });

  // ============================================================
  // Firefox mode (v1.9) — no showSaveFilePicker -> download fallback.
  // The download path must NEVER count as a confirmed save.
  // ============================================================

  // Q — download keeps the session; user confirming arrival deletes it
  await scenario('Q firefox download keeps session; confirm deletes it', async () => {
    const id = await seed(2);
    state.sessionId = id; state.chunkIndex = 2;
    await api.finalizeRecording();
    await drain();
    assert(downloadClicks.length === 1, 'download fired once (got ' + downloadClicks.length + ')');
    let sessions = await readStore('sessions');
    assert(sessions.length === 1, 'session KEPT after unconfirmed download (got ' + sessions.length + ')');
    const bar = documentMock.getElementById('downloadConfirm');
    assert(bar.classList.contains('visible'), 'confirm bar shown');
    await sandbox.confirmDownloadArrived();
    await drain();
    sessions = await readStore('sessions');
    assert(sessions.length === 0, 'session deleted after user confirms arrival (got ' + sessions.length + ')');
    assert(!bar.classList.contains('visible'), 'confirm bar hidden after confirm');
  });

  // R — download + "didn't arrive" keeps the recording recoverable
  await scenario('R firefox download decline keeps recording recoverable', async () => {
    const id = await seed(2);
    state.sessionId = id; state.chunkIndex = 2;
    await api.finalizeRecording();
    await drain();
    sandbox.keepDownloadSession();
    const sessions = await readStore('sessions');
    const chunks = await readStore('chunks');
    assert(sessions.length === 1, 'session still kept after decline (got ' + sessions.length + ')');
    assert(chunks.length === 2, 'chunks still kept after decline (got ' + chunks.length + ')');
    assert(recordedErrors.some(m => /kept safe|recover/i.test(m)), 'user told how to get it back');
    assert(!documentMock.getElementById('downloadConfirm').classList.contains('visible'), 'confirm bar dismissed');
  });

  // S — stitched download keeps ALL segments until confirmed
  // BEHAVIOR CHANGE (same as D): reseeded with real WebM fixtures so pass 1
  // succeeds instead of bailing on 1-byte garbage, keeping this on the
  // download-success path it was written to test.
  await scenario('S firefox stitched download keeps all segments until confirmed', async () => {
    const [p1, p2, cur] = await seedSegments([syntheticWebm(), syntheticWebm(), syntheticWebm()]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }, { sessionId: p2, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    await api.finalizeRecording();
    await drain();
    assert(downloadClicks.length === 1, 'one stitched download fired (got ' + downloadClicks.length + ')');
    let sessions = await readStore('sessions');
    assert(sessions.length === 3, 'all 3 sessions kept after unconfirmed download (got ' + sessions.length + ')');
    await sandbox.confirmDownloadArrived();
    await drain();
    sessions = await readStore('sessions');
    assert(sessions.length === 0, 'all sessions deleted after confirm (got ' + sessions.length + ')');
    assert(state.priorSegments.length === 0, 'priorSegments cleared after confirm');
  });

  // T — recovery stitch BAILS (Firefox): every part downloads, all kept until confirmed.
  // Same bail-not-throw change as E/E2 — no picker exists in Firefox mode, so
  // there's no picker-call bookkeeping to adjust; the stub is just removed.
  await scenario('T firefox recovery stitch-bail keeps all parts until confirmed', async () => {
    const s1 = await seed(2), s2 = await seed(2);
    windowMock._recoverySessions = [{ id: s1, mimeType: 'video/webm' }, { id: s2, mimeType: 'video/webm' }];
    await api.recoverRecording();
    await drain();
    assert(downloadClicks.length === 2, 'both parts downloaded (got ' + downloadClicks.length + ')');
    let sessions = await readStore('sessions');
    assert(sessions.length === 2, 'both sessions kept after unconfirmed downloads (got ' + sessions.length + ')');
    assert(documentMock.getElementById('downloadConfirm').classList.contains('visible'), 'one confirm bar for all parts');
    await sandbox.confirmDownloadArrived();
    await drain();
    sessions = await readStore('sessions');
    assert(sessions.length === 0, 'all parts deleted after confirm (got ' + sessions.length + ')');
    assert(!documentMock.getElementById('recoveryBanner').classList.contains('visible'), 'recovery banner cleared');
  });

  // ============================================================
  // makeSeekable (v1.8) — synthetic WebM builder + assertions
  // ============================================================
  // Chrome-accurate shape: Segment has an 8-byte unknown-size VINT; Clusters use
  // 1-byte unknown-size markers (0xFF); Timestamp is the first Cluster child.
  const S = sandbox;
  function sizeVint(n) {
    if (n <= 0x7E) return Buffer.from([0x80 | n]);
    if (n <= 0x3FFE) return Buffer.from([0x40 | (n >> 8), n & 0xFF]);
    throw new Error('test sizeVint: too big');
  }
  function uintBytes(n, w) { const b = Buffer.alloc(w); for (let i = w - 1; i >= 0; i--) { b[i] = n & 0xFF; n = Math.floor(n / 256); } return b; }
  function el(idBytes, ...data) { const d = Buffer.concat(data.map(x => Buffer.from(x))); return Buffer.concat([Buffer.from(idBytes), sizeVint(d.length), d]); }
  function simpleBlock(track, relTs, flags, payloadLen) {
    const rel = Buffer.alloc(2); rel.writeInt16BE(relTs);
    return el([0xA3], Buffer.from([0x80 | track]), rel, Buffer.from([flags]), Buffer.alloc(payloadLen, 0xAB));
  }
  function clusterUnknown(ts, blocks, marker8) {
    // Chrome writes a 1-byte unknown-size marker (0xFF); Firefox writes the
    // 8-byte form (0x01 FF FF FF FF FF FF FF). Both must parse identically.
    const marker = marker8 ? Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]) : Buffer.from([0xFF]);
    const tsW = ts <= 0xFF ? 1 : 2;
    return Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), marker,
      el([0xE7], uintBytes(ts, tsW)), ...blocks]);
  }
  function syntheticWebm() {
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])),   // video, track 1
      el([0xAE], el([0xD7], [0x02]), el([0x83], [0x02])));  // audio, track 2
    const c0 = clusterUnknown(0,    [simpleBlock(1, 0, 0x80, 40), simpleBlock(2, 5, 0x80, 10), simpleBlock(1, 500, 0x00, 30)]);
    const c1 = clusterUnknown(1000, [simpleBlock(1, 0, 0x00, 30), simpleBlock(2, 3, 0x80, 10)]); // first video block NOT key
    const c2 = clusterUnknown(2000, [simpleBlock(2, 0, 0x80, 10), simpleBlock(1, 10, 0x80, 40), simpleBlock(1, 900, 0x00, 25)]);
    return Buffer.concat([header, segHdr, infoEl, tracks, c0, c1, c2]);
  }
  function childElems(view, start, end) {
    const out = []; let pos = start;
    while (pos < end) {
      const id = S.ebmlReadId(view, pos); if (!id) break;
      const sz = S.ebmlReadSize(view, pos + id.length); if (!sz || sz.isUnknown) break;
      const ds = pos + id.length + sz.length;
      out.push({ id: id.value, start: pos, dataStart: ds, dataEnd: ds + sz.value });
      pos = ds + sz.value;
    }
    return out;
  }

  // K — makeSeekable injects Duration + Cues; structure verifies end-to-end
  await scenario('K makeSeekable adds Duration + Cues to a synthetic recording', async () => {
    const src = syntheticWebm();
    const out = await S.makeSeekable(new Blob([src]));
    assert(out.size > src.length, 'output grew (indexed), ' + src.length + ' -> ' + out.size);
    const buf = await out.arrayBuffer();
    const view = new DataView(buf);
    const rescan = S.webmScan(buf); // (a) output still parses via webmScan
    assert(rescan.clusters.length === 3, 'clusters preserved (got ' + rescan.clusters.length + ')');
    assert(rescan.clusters.map(c => c.timestamp).join(',') === '0,1000,2000', 'cluster timestamps unchanged (got ' + rescan.clusters.map(c => c.timestamp) + ')');
    assert(rescan.timestampScale === 1000000, 'timestampScale preserved');
    const segData = rescan.segmentDataStart;
    // First Segment child is the SeekHead
    assert(view.getUint32(segData, false) === 0x114D9B74, 'SeekHead is first Segment child');
    // (c) Info now has a Duration float ≈ 2000 + 900 + 33
    assert(rescan.infoStart !== null, 'Info found in output');
    const infoKids = childElems(view, rescan.infoDataStart, rescan.infoDataEnd);
    const dur = infoKids.find(k => k.id === 0x4489);
    assert(!!dur, 'Duration element present in Info');
    const durVal = dur ? view.getFloat64(dur.dataStart, false) : -1;
    assert(durVal > 2900 && durVal < 3000, 'Duration ≈ 2933 ticks (got ' + durVal + ')');
    // (b) Cues element exists — find it via the SeekHead
    const shSize = S.ebmlReadSize(view, segData + 4);
    const seeks = childElems(view, segData + 4 + shSize.length, segData + 4 + shSize.length + shSize.value);
    const positions = {};
    for (const s of seeks) {
      const kids = childElems(view, s.dataStart, s.dataEnd);
      const idEl = kids.find(k => k.id === 0x53AB), posEl = kids.find(k => k.id === 0x53AC);
      const target = S.ebmlReadUInt(view, idEl.dataStart, idEl.dataEnd - idEl.dataStart);
      positions[target] = S.ebmlReadUInt(view, posEl.dataStart, posEl.dataEnd - posEl.dataStart);
    }
    assert(view.getUint32(segData + positions[0x1549A966], false) === 0x1549A966, 'SeekHead → Info resolves');
    assert(view.getUint32(segData + positions[0x1654AE6B], false) === 0x1654AE6B, 'SeekHead → Tracks resolves');
    const cuesAt = segData + positions[0x1C53BB6B];
    assert(view.getUint32(cuesAt, false) === 0x1C53BB6B, 'SeekHead → Cues resolves');
    // CuePoints: c0 and c2 only (c1's first video block is not a keyframe)
    const cuesSize = S.ebmlReadSize(view, cuesAt + 4);
    const cuePoints = childElems(view, cuesAt + 4 + cuesSize.length, cuesAt + 4 + cuesSize.length + cuesSize.value);
    assert(cuePoints.length === 2, 'two CuePoints — non-keyframe cluster skipped (got ' + cuePoints.length + ')');
    const cueTimes = [], cuePositions = [], cueTracks = [];
    for (const cp of cuePoints) {
      const kids = childElems(view, cp.dataStart, cp.dataEnd);
      const t = kids.find(k => k.id === 0xB3);
      cueTimes.push(S.ebmlReadUInt(view, t.dataStart, t.dataEnd - t.dataStart));
      const tp = kids.find(k => k.id === 0xB7);
      const tpKids = childElems(view, tp.dataStart, tp.dataEnd);
      const trk = tpKids.find(k => k.id === 0xF7), cpos = tpKids.find(k => k.id === 0xF1);
      cueTracks.push(S.ebmlReadUInt(view, trk.dataStart, trk.dataEnd - trk.dataStart));
      cuePositions.push(S.ebmlReadUInt(view, cpos.dataStart, cpos.dataEnd - cpos.dataStart));
    }
    assert(cueTimes.join(',') === '0,2000', 'CueTimes are 0,2000 (got ' + cueTimes + ')');
    assert(cueTracks.every(t => t === 1), 'CueTrack is the video track (got ' + cueTracks + ')');
    // (d) every CueClusterPosition resolves to an actual cluster offset
    const clusterOffsets = rescan.clusters.map(c => c.offset);
    const resolved = cuePositions.map(p => segData + p);
    assert(resolved.every(p => view.getUint32(p, false) === 0x1F43B675), 'cue positions land on Cluster IDs');
    assert(resolved[0] === clusterOffsets[0] && resolved[1] === clusterOffsets[2], 'cues point at clusters 0 and 2 (got ' + resolved + ' vs ' + clusterOffsets + ')');
  });

  // K2 — the full finalize path writes an indexed file
  await scenario('K2 finalizeRecording writes a seekable file', async () => {
    const src = syntheticWebm();
    const mid = Math.floor(src.length / 2);
    const id = await api.createSession('video/webm;codecs=vp9,opus');
    await api.addChunk(id, 0, new Blob([src.slice(0, mid)]));
    await api.addChunk(id, 1, new Blob([src.slice(mid)]));
    state.sessionId = id; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    assert(lastWritten.length === 1, 'one file written');
    const written = lastWritten[0];
    assert(written.size > src.length, 'written file is indexed (grew ' + src.length + ' -> ' + written.size + ')');
    const buf = await written.arrayBuffer();
    const rescan = S.webmScan(buf);
    assert(rescan.clusters.length === 3, 'written file parses with all clusters');
    const view = new DataView(buf);
    assert(view.getUint32(rescan.segmentDataStart, false) === 0x114D9B74, 'written file starts Segment with SeekHead');
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'session deleted after indexed save');
  });

  // L — corrupt input falls back to the ORIGINAL blob (saving must never fail)
  await scenario('L makeSeekable returns original blob on corrupt input', async () => {
    const junk = new Blob([Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03])]);
    const out = await S.makeSeekable(junk);
    assert(out === junk, 'identical blob object returned for junk input');
    const noClusters = new Blob([Buffer.concat([
      Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]),
      Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    ])]);
    const out2 = await S.makeSeekable(noClusters);
    assert(out2 === noClusters, 'header-only file (no clusters) passes through unchanged');
  });

  // M — truncated (crash-tail) file still gets indexed from the intact clusters
  await scenario('M makeSeekable tolerates a truncated final cluster', async () => {
    const src = syntheticWebm().slice(0, -20); // cut into c2's final block
    const orig = new Blob([src]);
    const out = await S.makeSeekable(orig);
    assert(out !== orig, 'truncated file still indexed');
    const buf = await out.arrayBuffer();
    const rescan = S.webmScan(buf);
    assert(rescan.clusters.length === 3, 'all clusters carried over (got ' + rescan.clusters.length + ')');
    const view = new DataView(buf);
    const infoKids = childElems(view, rescan.infoDataStart, rescan.infoDataEnd);
    const dur = infoKids.find(k => k.id === 0x4489);
    const durVal = dur ? view.getFloat64(dur.dataStart, false) : -1;
    assert(durVal >= 2033 && durVal <= 2933, 'Duration from intact blocks (got ' + durVal + ')');
  });

  // N — unknown-size VINT detection is byte-pattern based (REVIEW P2 #9 / Firefox bug)
  await scenario('N unknown-size VINT detection by byte pattern', async () => {
    const rd = (bytes) => {
      const b = Buffer.from(bytes);
      return S.ebmlReadSize(new DataView(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), 0);
    };
    assert(rd([0xFF]).isUnknown === true, '1-byte 0xFF is unknown (Chrome cluster marker)');
    assert(rd([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]).isUnknown === true, '8-byte all-ones is unknown (Firefox cluster / Segment marker)');
    assert(rd([0x7F, 0xFF]).isUnknown === true, '2-byte all-ones is unknown');
    const known8 = rd([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x39]);
    assert(known8.isUnknown === false && known8.value === 0x3039, 'legit 8-byte size stays known with exact value (got ' + known8.value + ')');
    assert(rd([0x81]).isUnknown === false && rd([0x81]).value === 1, '1-byte known size unaffected');
  });

  // O — Firefox-shaped file (8-byte unknown cluster markers) gets fully indexed
  await scenario('O makeSeekable indexes Firefox-style 8-byte cluster markers', async () => {
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])),
      el([0xAE], el([0xD7], [0x02]), el([0x83], [0x02])));
    const c0 = clusterUnknown(0,    [simpleBlock(1, 0, 0x80, 40), simpleBlock(2, 5, 0x80, 10)], true);
    const c1 = clusterUnknown(7504, [simpleBlock(1, 0, 0x80, 40)], true);
    const c2 = clusterUnknown(15000,[simpleBlock(1, 0, 0x80, 40), simpleBlock(1, 480, 0x00, 20)], true);
    const src = Buffer.concat([header, segHdr, infoEl, tracks, c0, c1, c2]);
    // The regression this guards: pre-fix, the 8-byte marker parsed as a huge KNOWN
    // size, webmScan saw ONE cluster to EOF, and Duration got pinned to the first
    // cluster — Firefox then refused to play past the "end".
    const scan0 = S.webmScan(src.buffer.slice(src.byteOffset, src.byteOffset + src.length));
    assert(scan0.clusters.length === 3, 'webmScan finds all 3 Firefox-marker clusters (got ' + scan0.clusters.length + ')');
    const out = await S.makeSeekable(new Blob([src]));
    assert(out.size > src.length, 'Firefox-shaped file was indexed');
    const buf = await out.arrayBuffer();
    const view = new DataView(buf);
    const rescan = S.webmScan(buf);
    assert(rescan.clusters.length === 3, 'output preserves all clusters (got ' + rescan.clusters.length + ')');
    assert(rescan.clusters.map(c => c.timestamp).join(',') === '0,7504,15000', 'cluster timestamps intact');
    const infoKids = childElems(view, rescan.infoDataStart, rescan.infoDataEnd);
    const dur = infoKids.find(k => k.id === 0x4489);
    const durVal = dur ? view.getFloat64(dur.dataStart, false) : -1;
    assert(durVal > 15000 && durVal < 15600, 'Duration reflects the LAST cluster, not the first (got ' + durVal + ')');
    // all three clusters are keyframe-led → 3 CuePoints, each landing on a Cluster ID
    const segData = rescan.segmentDataStart;
    const shSize = S.ebmlReadSize(view, segData + 4);
    const seeks = childElems(view, segData + 4 + shSize.length, segData + 4 + shSize.length + shSize.value);
    let cuesPos = -1;
    for (const s of seeks) {
      const kids = childElems(view, s.dataStart, s.dataEnd);
      const idEl = kids.find(k => k.id === 0x53AB), posEl = kids.find(k => k.id === 0x53AC);
      if (S.ebmlReadUInt(view, idEl.dataStart, idEl.dataEnd - idEl.dataStart) === 0x1C53BB6B)
        cuesPos = S.ebmlReadUInt(view, posEl.dataStart, posEl.dataEnd - posEl.dataStart);
    }
    assert(cuesPos > 0 && view.getUint32(segData + cuesPos, false) === 0x1C53BB6B, 'SeekHead → Cues resolves');
    const cuesSize = S.ebmlReadSize(view, segData + cuesPos + 4);
    const cuePoints = childElems(view, segData + cuesPos + 4 + cuesSize.length, segData + cuesPos + 4 + cuesSize.length + cuesSize.value);
    assert(cuePoints.length === 3, 'three CuePoints for three keyframe clusters (got ' + cuePoints.length + ')');
    for (const cp of cuePoints) {
      const tp = childElems(view, cp.dataStart, cp.dataEnd).find(k => k.id === 0xB7);
      const cpos = childElems(view, tp.dataStart, tp.dataEnd).find(k => k.id === 0xF1);
      const p = segData + S.ebmlReadUInt(view, cpos.dataStart, cpos.dataEnd - cpos.dataStart);
      assert(view.getUint32(p, false) === 0x1F43B675, 'cue position lands on a Cluster ID');
    }
  });

  // P — coverage guard: if the top-level scan stops early, save un-indexed
  await scenario('P makeSeekable bails when the scan cannot cover the file', async () => {
    // Known-size clusters (so nothing byte-scan-swallows the poison), then an
    // unknown-size NON-cluster element the scanner stops at, then an 8KB tail.
    // Rebuilding from the parsed part would silently drop the tail — must bail.
    function clusterKnown(ts, blocks) {
      const data = Buffer.concat([el([0xE7], uintBytes(ts, 2)), ...blocks]);
      return Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), sizeVint(data.length), data]);
    }
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B], el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])));
    const c0 = clusterKnown(0, [simpleBlock(1, 0, 0x80, 40)]);
    const c1 = clusterKnown(1000, [simpleBlock(1, 0, 0x80, 40)]);
    const poison = Buffer.concat([header, segHdr, infoEl, tracks, c0, c1,
      Buffer.from([0xEC, 0xFF]), Buffer.alloc(8192, 0x42)]);
    const scanP = S.webmScan(poison.buffer.slice(poison.byteOffset, poison.byteOffset + poison.length));
    assert(scanP.clusters.length === 2 && poison.length - scanP.scanEnd > 4096, 'precondition: scan stopped early with a big unparsed tail');
    const orig = new Blob([poison]);
    const out = await S.makeSeekable(orig);
    assert(out === orig, 'original blob returned when coverage is incomplete');
  });

  // ============================================================
  // Streamed save (v1.11, REVIEW #5) — differential + sink scenarios
  // ============================================================
  // The invariant: for ANY chunked file, the streamed save's output bytes must
  // equal makeSeekable() run on the concatenated blob — indexed files and bail
  // cases alike (an un-indexed streaming save emits the raw bytes verbatim,
  // which is exactly the original blob the buffered path falls back to).

  function syntheticFirefoxWebm() {   // 8-byte unknown-size cluster markers (scenario O shape)
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])),
      el([0xAE], el([0xD7], [0x02]), el([0x83], [0x02])));
    const c0 = clusterUnknown(0,    [simpleBlock(1, 0, 0x80, 40), simpleBlock(2, 5, 0x80, 10)], true);
    const c1 = clusterUnknown(7504, [simpleBlock(1, 0, 0x80, 40)], true);
    const c2 = clusterUnknown(15000,[simpleBlock(1, 0, 0x80, 40), simpleBlock(1, 480, 0x00, 20)], true);
    return Buffer.concat([header, segHdr, infoEl, tracks, c0, c1, c2]);
  }
  function syntheticAudioOnlyWebm() { // no video track → Duration-only indexing
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x02])));   // audio only
    const c0 = clusterUnknown(0,   [simpleBlock(1, 0, 0x80, 20)]);
    const c1 = clusterUnknown(900, [simpleBlock(1, 40, 0x80, 20)]);
    return Buffer.concat([header, segHdr, infoEl, tracks, c0, c1]);
  }
  function syntheticPoisonWebm() {    // unknown-size non-cluster + 8KB tail → both paths bail
    function clusterKnown(ts, blocks) {
      const data = Buffer.concat([el([0xE7], uintBytes(ts, 2)), ...blocks]);
      return Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), sizeVint(data.length), data]);
    }
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B], el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])));
    const c0 = clusterKnown(0, [simpleBlock(1, 0, 0x80, 40)]);
    const c1 = clusterKnown(1000, [simpleBlock(1, 0, 0x80, 40)]);
    return Buffer.concat([header, segHdr, infoEl, tracks, c0, c1,
      Buffer.from([0xEC, 0xFF]), Buffer.alloc(8192, 0x42)]);
  }
  function preambleOnlyWebm() {       // valid preamble, zero clusters
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])),
      el([0xAE], el([0xD7], [0x02]), el([0x83], [0x02])));
    return Buffer.concat([header, segHdr, infoEl, tracks]);
  }

  async function seedBuffers(parts, indexes) {
    const id = await api.createSession('video/webm;codecs=vp9,opus');
    for (let i = 0; i < parts.length; i++) await api.addChunk(id, indexes ? indexes[i] : i, new Blob([parts[i]]));
    return id;
  }
  // One session per buffer (a multi-segment chain), each split into thirds — for
  // the Phase 0 oracle scenarios (STREAMING_STITCH_HANDOFF §5). Returns session
  // ids in order.
  async function seedSegments(buffers) {
    const ids = [];
    for (const buf of buffers) {
      const thirds = splitAt(buf, [Math.floor(buf.length / 3), Math.floor(2 * buf.length / 3)]);
      ids.push(await seedBuffers(thirds));
    }
    return ids;
  }
  function splitEveryByte(buf) { const out = []; for (let i = 0; i < buf.length; i++) out.push(buf.slice(i, i + 1)); return out; }
  function splitAt(buf, offsets) {
    const out = []; let prev = 0;
    for (const o of offsets) { if (o > prev && o < buf.length) { out.push(buf.slice(prev, o)); prev = o; } }
    out.push(buf.slice(prev));
    return out;
  }
  function clusterIdOffsets(buf) {
    const out = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x1F && buf[i + 1] === 0x43 && buf[i + 2] === 0xB6 && buf[i + 3] === 0x75) out.push(i);
    }
    return out;
  }
  async function expectedBytes(buf) {
    return Buffer.from(await (await S.makeSeekable(new Blob([buf]))).arrayBuffer());
  }
  // Phase 0 oracle (STREAMING_STITCH_HANDOFF §5): the REAL concatenateWebM +
  // makeSeekable, run over N segment buffers. Uses ORIG.concatenateWebM so this
  // stays the buffered reference even in scenarios that override sandbox.concatenateWebM.
  async function stitchOracle(buffers) {
    const stitched = await ORIG.concatenateWebM(buffers.map(b => new Blob([b])));
    return Buffer.from(await (await S.makeSeekable(stitched)).arrayBuffer());
  }
  // Phase 1: run the plan-level streamed stitch over segment buffers (each split
  // by splitFn) and ASSEMBLE the plan's bytes — no sinks exist yet.
  async function streamedPlanBytes(buffers, splitFn) {
    const scanner0 = S.createWebmStreamScanner();
    for (const part of splitFn(buffers[0])) scanner0.push(part);
    const ok0 = scanner0.finish();
    const scan0 = scanner0.result();
    const videoTrack = scan0.videoTrack;
    const segScans = [{ ok: ok0, scan: scan0 }];

    let prevScan = scan0;
    let offset = 0;
    for (let i = 1; i < buffers.length; i++) {
      offset += prevScan.maxClusterTs + 1000;
      const scanner = S.createWebmStreamScanner({ clustersOnly: true, timeOffset: offset, videoTrack });
      for (const part of splitFn(buffers[i])) scanner.push(part);
      const ok = scanner.finish();
      const scan = scanner.result();
      segScans.push({ ok, scan });
      prevScan = scan;
    }

    const plan = S.buildStitchPlanParts(segScans);
    if (plan.bail) return { bail: plan.bail };

    const parts = [];
    for (const p of plan.head) parts.push(Buffer.from(p));
    for (const e of plan.entries) {
      if (e.verbatim) {
        parts.push(Buffer.from(buffers[e.seg].slice(e.start, e.end)));
      } else {
        parts.push(Buffer.from(e.headerBytes));
        parts.push(Buffer.from(buffers[e.seg].slice(e.remStart, e.remEnd)));
      }
    }
    if (plan.cues) parts.push(Buffer.from(plan.cues));
    return Buffer.concat(parts);
  }
  async function runStreamedFSA(sessionId) {
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    const r = await S.saveFile({ kind: 'session', sessionId, mimeType: 'video/webm' });
    return { r, bytes: Buffer.from(await lastWritten.pop().arrayBuffer()) };
  }
  async function runStreamedDownload(sessionId) {
    delete windowMock.showSaveFilePicker;
    const r = await S.saveFile({ kind: 'session', sessionId, mimeType: 'video/webm' });
    return { r, bytes: Buffer.from(await objectUrlBlobs[objectUrlBlobs.length - 1].arrayBuffer()) };
  }

  // U — the differential star: streamed === buffered, per fixture × split
  await scenario('U streamed output byte-identical to makeSeekable (differential)', async () => {
    const fixtures = [
      { name: 'chrome',    buf: syntheticWebm(),               indexes: true },
      { name: 'firefox',   buf: syntheticFirefoxWebm(),        indexes: true },
      { name: 'truncated', buf: syntheticWebm().slice(0, -20), indexes: true },
      { name: 'audioOnly', buf: syntheticAudioOnlyWebm(),      indexes: true },
      { name: 'poison',    buf: syntheticPoisonWebm(),         indexes: false },  // both paths bail → raw
    ];
    for (const f of fixtures) {
      const want = await expectedBytes(f.buf);
      assert(f.indexes ? want.length > f.buf.length : want.length === f.buf.length,
        f.name + ': buffered baseline ' + (f.indexes ? 'indexes' : 'bails to the original'));
      const cids = clusterIdOffsets(f.buf);
      const splits = [
        ['whole',        [f.buf]],
        ['midClusterId', splitAt(f.buf, cids.map(o => o + 2))],
        ['midSizeVint',  splitAt(f.buf, cids.map(o => o + 5))],
        ['midTimestamp', splitAt(f.buf, cids.map(o => o + 6))],
        ['thirds',       splitAt(f.buf, [Math.floor(f.buf.length / 3), Math.floor(2 * f.buf.length / 3)])],
      ];
      // The brutal split — every byte its own chunk — for the real fixtures
      // (poison is ~8.5 KB of filler tail; per-byte chunking it adds runtime,
      // not coverage).
      if (f.buf.length < 1000) splits.push(['everyByte', splitEveryByte(f.buf)]);
      for (const [sname, parts] of splits) {
        const id = await seedBuffers(parts);
        const fsa = await runStreamedFSA(id);
        assert(fsa.r === 'saved' && Buffer.compare(fsa.bytes, want) === 0,
          f.name + '/' + sname + ': FSA streamed === buffered (' + fsa.bytes.length + ' vs ' + want.length + ' bytes)');
        const dl = await runStreamedDownload(id);
        assert(dl.r === 'downloaded' && Buffer.compare(dl.bytes, want) === 0,
          f.name + '/' + sname + ': download streamed === buffered');
      }
    }
  });

  // U2 — chunk-index gaps: stream what's there, exactly like the buffered path would
  await scenario('U2 streamed save tolerates chunk-index gaps', async () => {
    const buf = syntheticWebm();
    const q = Math.floor(buf.length / 4);
    const parts = [buf.slice(0, q), buf.slice(q, 2 * q), buf.slice(2 * q, 3 * q), buf.slice(3 * q)];
    const id = await seedBuffers(parts, [0, 1, 3, 4]);   // gap at index 2
    const want = await expectedBytes(buf);
    const fsa = await runStreamedFSA(id);
    assert(fsa.r === 'saved' && Buffer.compare(fsa.bytes, want) === 0, 'gapped indexes stream the full byte sequence');
  });

  // V — picker-first: cancel costs nothing (no pass 1, no cursor work)
  await scenario('V streamed FSA cancel-before-work', async () => {
    const id = await seedBuffers([syntheticWebm()]);
    windowMock.showSaveFilePicker = pickerSequence(['abort']);
    const r = await S.saveFile({ kind: 'session', sessionId: id, mimeType: 'video/webm' });
    assert(r === 'cancelled', 'picker cancel → cancelled');
    assert(writeCalls.length === 0 && lastWritten.length === 0, 'nothing written');
    assert(!statusHistory.some(t => /Preparing/.test(t)), 'pass 1 never started');
    const chunks = await readStore('chunks');
    assert(chunks.length === 1, 'chunks untouched');
  });

  // V2 — mid-write failure: abort() the swap file, keep the session
  await scenario('V2 streamed FSA mid-write failure aborts and keeps the session', async () => {
    const src = syntheticWebm();
    const mid = Math.floor(src.length / 2);
    const id = await seedBuffers([src.slice(0, mid), src.slice(mid)]);
    state.sessionId = id; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    failWriteAfter = 2;   // third write() throws
    await api.finalizeRecording();
    await drain();
    assert(abortCalls === 1, 'writable.abort() called (got ' + abortCalls + ')');
    assert(closedFiles === 0 && lastWritten.length === 0, 'no file finalized');
    const sessions = await readStore('sessions');
    assert(sessions.length === 1, 'session kept after failed save (got ' + sessions.length + ')');
    assert(recordedErrors.some(m => /Save failed/.test(m) && /safe/i.test(m)), 'failure message points at recovery');
  });

  // V3 — progress + close ordering through the real finalize path
  await scenario('V3 streamed FSA shows progress to 100% and deletes only after close', async () => {
    const parts = splitEveryByte(syntheticWebm());
    const id = await seedBuffers(parts);
    state.sessionId = id; state.chunkIndex = parts.length;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    assert(statusHistory.some(t => /Preparing your video/.test(t)), 'pass-1 status shown');
    assert(statusHistory.some(t => t === 'Saving… 100%'), 'progress reached 100%');
    assert(closedFiles === 1 && lastWritten.length === 1, 'exactly one file closed');
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'session deleted only after the confirmed (closed) save');
  });

  // W — Firefox: composed download blob identical; v1.9 confirm flow intact
  await scenario('W firefox streamed download blob identical + confirm flow', async () => {
    const src = syntheticWebm();
    const mid = Math.floor(src.length / 2);
    const id = await seedBuffers([src.slice(0, mid), src.slice(mid)]);
    state.sessionId = id; state.chunkIndex = 2;
    await api.finalizeRecording();   // Firefox mode (resetState removed the picker)
    await drain();
    assert(downloadClicks.length === 1, 'one download fired');
    const got = Buffer.from(await objectUrlBlobs[objectUrlBlobs.length - 1].arrayBuffer());
    const want = await expectedBytes(src);
    assert(Buffer.compare(got, want) === 0, 'downloaded blob === buffered makeSeekable output');
    let sessions = await readStore('sessions');
    assert(sessions.length === 1, 'session kept until the user confirms arrival');
    await sandbox.confirmDownloadArrived();
    await drain();
    sessions = await readStore('sessions');
    assert(sessions.length === 0, 'confirm deletes the session');
  });

  // X — rider: recovery banner numbers via cursor-sum (no chunk getAll at load)
  await scenario('X recovery banner numbers via cursor-sum', async () => {
    const a = await api.createSession('video/webm');
    for (let i = 0; i < 3; i++) await api.addChunk(a, i, new Blob(['0123456789']));   // 3 × 10 B
    const b = await api.createSession('video/webm');
    for (let i = 0; i < 2; i++) await api.addChunk(b, i, new Blob(['12345']));        // 2 × 5 B
    await sandbox.checkForRecovery();
    await drain();
    assert(documentMock.getElementById('recoveryBanner').classList.contains('visible'), 'banner shown');
    const txt = documentMock.getElementById('recoveryInfo').textContent;
    assert(/^Found 5 chunks \(~0m 5s, 0\.0 MB\) across 2 segments/.test(txt), 'banner text correct (got: ' + txt + ')');
  });

  // Z — carry cap exceeded → un-indexed streaming save (raw bytes, still saves)
  await scenario('Z carry cap exceeded falls back to raw streaming save', async () => {
    const src = syntheticWebm();
    const id = await seedBuffers([src]);
    sandbox.STREAM_CARRY_CAP = 32;   // absurdly small — force the bail
    const fsa = await runStreamedFSA(id);
    assert(fsa.r === 'saved', 'still saves');
    assert(Buffer.compare(fsa.bytes, src) === 0, 'raw un-indexed output, byte-for-byte the recording');
  });

  // ============================================================
  // Permission-prompt fix (REVIEW P2 #7) — v1.12
  // ============================================================
  await scenario('AA enumerateDevices() at load requests no media permission', async () => {
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: '' }, { kind: 'audioinput', deviceId: 'mic1', label: '' }];
    await sandbox.enumerateDevices();
    await drain();
    assert(getUserMediaCalls.length === 0, 'no getUserMedia call from enumerateDevices (got ' + getUserMediaCalls.length + ')');
  });

  await scenario('AB devicechange re-enumeration is also prompt-free', async () => {
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: '' }];
    dispatchDeviceChange();
    await drain();
    assert(getUserMediaCalls.length === 0, 'devicechange-triggered enumerate makes no getUserMedia call');
  });

  await scenario('AC toggling Webcam on requests camera permission lazily (not before)', async () => {
    state.sources = { screen: true, camera: false, mic: true };
    await sandbox.enumerateDevices();
    await drain();
    assert(getUserMediaCalls.length === 0, 'still zero after initial enumerate');
    sandbox.toggleSource('camera');
    await drain();
    assert(getUserMediaCalls.length === 1, 'exactly one getUserMedia call from the toggle (got ' + getUserMediaCalls.length + ')');
    assert(getUserMediaCalls[0].video && getUserMediaCalls[0].audio === false, 'camera toggle requests video only');
  });

  await scenario('AD captureMic() requests mic permission only', async () => {
    await sandbox.captureMic();
    await drain();
    assert(getUserMediaCalls.length === 1, 'exactly one getUserMedia call (got ' + getUserMediaCalls.length + ')');
    assert(getUserMediaCalls[0].video === false && getUserMediaCalls[0].audio, 'mic-only constraints');
  });

  await scenario('AE a blank re-enumerated label never overwrites a known-good one', async () => {
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: 'Logitech BRIO' }];
    await sandbox.enumerateDevices();
    await drain();
    const camSelect = documentMock.getElementById('cameraSelect');
    let opt = camSelect.querySelector('option[value="cam1"]');
    assert(opt && opt.textContent === 'Logitech BRIO', 'label populated on first enumerate (got: ' + (opt && opt.textContent) + ')');

    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: '' }];  // Firefox: blanks once the stream stops
    await sandbox.enumerateDevices();
    await drain();
    opt = camSelect.querySelector('option[value="cam1"]');
    assert(opt && opt.textContent === 'Logitech BRIO', 'known-good label survives a blank re-enumerate (got: ' + (opt && opt.textContent) + ')');
  });

  await scenario('AF device selection survives the label-upgrade re-enumerate', async () => {
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: '' }, { kind: 'videoinput', deviceId: 'cam2', label: '' }];
    await sandbox.enumerateDevices();
    await drain();
    state.selectedCamera = 'cam2';
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: 'Front camera' }, { kind: 'videoinput', deviceId: 'cam2', label: 'USB webcam' }];
    await sandbox.enumerateDevices();
    await drain();
    assert(documentMock.getElementById('cameraSelect').value === 'cam2', 'selection preserved through label upgrade');
  });

  // ============================================================
  // Camera-only discoverability (v1.12)
  // ============================================================
  await scenario('AG screen-off with camera off is a no-op with a visible explanation', async () => {
    state.sources = { screen: true, camera: false, mic: true };
    sandbox.toggleSource('screen');
    assert(state.sources.screen === true, 'screen forced back on (guard still enforced)');
    assert(recordedErrors.length > 0 && /screen/i.test(recordedErrors[recordedErrors.length - 1]), 'a message explains the revert (got: ' + JSON.stringify(recordedErrors) + ')');
  });

  await scenario('AH camera-only is reachable: screen-off with camera already on', async () => {
    state.sources = { screen: true, camera: true, mic: true };
    state.cameraStream = makeStream([{ kind: 'video', getSettings: () => ({ width: 320, height: 240 }), addEventListener() {}, stop() {} }]);
    sandbox.toggleSource('screen');
    assert(state.sources.screen === false && state.sources.camera === true, 'camera-only state reached');
    assert(recordedErrors[recordedErrors.length - 1] === '', 'no stale hint shown for a real toggle');
    assert(documentMock.getElementById('placeholder').classList.contains('hidden'), 'placeholder hidden — the viewer shows the camera, not a blank canvas');
    assert(typeof state.drawFrame === 'function', 'compositing started for the camera-only preview');
  });

  await scenario('AI toggling camera off in camera-only mode reverts with an explanation', async () => {
    state.sources = { screen: false, camera: true, mic: true };
    sandbox.toggleSource('camera');
    assert(state.sources.screen === true && state.sources.camera === false, 'reverted to screen mode');
    assert(recordedErrors.length > 0 && /screen/i.test(recordedErrors[recordedErrors.length - 1]), 'the snap-back is explained, not silent');
    assert(!documentMock.getElementById('placeholder').classList.contains('hidden'), 'placeholder restored — no dead canvas after leaving camera-only');
  });

  await scenario('AJ camera defaults off (no stream at load, so the toggle is truthful)', async () => {
    assert(state.sources.camera === false, 'state.sources.camera defaults to false (got ' + state.sources.camera + ')');
  });

  // AK — a 2nd unresolved download appends to the confirm bar (no overwrite)
  await scenario('AK second unresolved download appends to confirm bar', async () => {
    const id1 = await seed(1);
    const id2 = await seed(1);
    sandbox.offerDownloadConfirm([id1], 1);
    sandbox.offerDownloadConfirm([id2], 1);
    assert(sandbox.downloadPendingIds.length === 2, 'both sessions covered (got ' + sandbox.downloadPendingIds.length + ')');
    const msg = documentMock.getElementById('downloadConfirmMsg').textContent;
    assert(/2 recording files/.test(msg), 'bar message counts both files (got "' + msg + '")');
    sandbox.offerDownloadConfirm([id2], 1);
    assert(sandbox.downloadPendingIds.length === 2, 're-offering a covered session does not duplicate its id');
    await sandbox.confirmDownloadArrived();
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'confirm deletes BOTH sessions (got ' + sessions.length + ')');
    assert(sandbox.downloadPendingFiles === 0, 'file count reset after confirm');
  });

  // ============================================================
  // Phase 0 — the buffered-stitch oracle (STREAMING_STITCH_HANDOFF §5)
  // ============================================================
  // Pins today's makeSeekable(concatenateWebM(segments)) behavior byte-level,
  // before the streamed multi-segment rewrite begins.

  // AL — 2-segment Chrome+Chrome oracle structure
  await scenario('AL 2-segment Chrome+Chrome oracle structure', async () => {
    const out = await stitchOracle([syntheticWebm(), syntheticWebm()]);
    let headerCount = 0;
    for (let i = 0; i + 3 < out.length; i++) {
      if (out[i] === 0x1A && out[i+1] === 0x45 && out[i+2] === 0xDF && out[i+3] === 0xA3) headerCount++;
    }
    assert(headerCount === 1, 'exactly one EBML header in stitched output (got ' + headerCount + ')');
    const view = new DataView(out.buffer, out.byteOffset, out.length);
    const rescan = S.webmScan(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    // segment 1 verbatim 0,1000,2000 (lastTimestamp 2000); segment 2 rebased by 2000+1000=3000
    assert(rescan.clusters.map(c => c.timestamp).join(',') === '0,1000,2000,3000,4000,5000',
      'segment 2 clusters rebased by segment 1 lastTimestamp+1000 (got ' + rescan.clusters.map(c => c.timestamp) + ')');
    const infoKids = childElems(view, rescan.infoDataStart, rescan.infoDataEnd);
    const dur = infoKids.find(k => k.id === 0x4489);
    const durVal = dur ? view.getFloat64(dur.dataStart, false) : -1;
    assert(durVal > 5900 && durVal < 6000, 'Duration reflects the 2-segment total, 2933+3000 (got ' + durVal + ')');
    const segData = rescan.segmentDataStart;
    const shSize = S.ebmlReadSize(view, segData + 4);
    const seeks = childElems(view, segData + 4 + shSize.length, segData + 4 + shSize.length + shSize.value);
    let cuesPos = -1;
    for (const s of seeks) {
      const kids = childElems(view, s.dataStart, s.dataEnd);
      const idEl = kids.find(k => k.id === 0x53AB), posEl = kids.find(k => k.id === 0x53AC);
      if (S.ebmlReadUInt(view, idEl.dataStart, idEl.dataEnd - idEl.dataStart) === 0x1C53BB6B)
        cuesPos = S.ebmlReadUInt(view, posEl.dataStart, posEl.dataEnd - posEl.dataStart);
    }
    const cuesAt = segData + cuesPos;
    const cuesSize = S.ebmlReadSize(view, cuesAt + 4);
    const cuePoints = childElems(view, cuesAt + 4 + cuesSize.length, cuesAt + 4 + cuesSize.length + cuesSize.value);
    const cueTimes = cuePoints.map(cp => {
      const t = childElems(view, cp.dataStart, cp.dataEnd).find(k => k.id === 0xB3);
      return S.ebmlReadUInt(view, t.dataStart, t.dataEnd - t.dataStart);
    });
    assert(cueTimes.join(',') === '0,2000,3000,5000', 'cues cover both segments, rebased (got ' + cueTimes + ')');
  });

  // AM — 3-segment mixed chain: Chrome + Firefox (8-byte marker) + Chrome
  await scenario('AM 3-segment mixed chain (Chrome+Firefox+Chrome)', async () => {
    const out = await stitchOracle([syntheticWebm(), syntheticFirefoxWebm(), syntheticWebm()]);
    const view = new DataView(out.buffer, out.byteOffset, out.length);
    const rescan = S.webmScan(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    assert(rescan.clusters.length === 9, '9 clusters total, 3+3+3 (got ' + rescan.clusters.length + ')');
    // seg1 verbatim 0,1000,2000; seg2 offset = 2000+1000=3000 -> 3000,10504,18000 (firefox ts 0,7504,15000);
    // seg3 offset = 3000 + (15000+1000) = 19000 -> 19000,20000,21000 (cumulative across BOTH gaps)
    assert(rescan.clusters.map(c => c.timestamp).join(',') === '0,1000,2000,3000,10504,18000,19000,20000,21000',
      'cumulative rebasing across both segment gaps (got ' + rescan.clusters.map(c => c.timestamp) + ')');
    // The Firefox segment's clusters are rewritten (not verbatim — only segment 1 is).
    // webmRewriteCluster preserves unknown-size via the constant EBML_UNKNOWN_SIZE
    // (8-byte 0x01 FFx7) for ANY sizeIsUnknown cluster it rewrites — byte-check that
    // pattern survives here, where the source segment already used an 8-byte marker.
    for (const c of rescan.clusters.slice(3, 6)) {
      const b0 = view.getUint8(c.offset + 4);
      const rest = [1,2,3,4,5,6,7].map(i => view.getUint8(c.offset + 4 + i));
      assert(b0 === 0x01 && rest.every(x => x === 0xFF),
        'rewritten firefox cluster keeps an 8-byte unknown-size marker (got 0x' + b0.toString(16) + ' ' + rest.map(x => x.toString(16)) + ')');
    }
  });

  // AN — audio-only chain (2 segments): Duration rebased, no video Cues at all
  await scenario('AN audio-only chain, Duration-only indexing', async () => {
    const out = await stitchOracle([syntheticAudioOnlyWebm(), syntheticAudioOnlyWebm()]);
    const view = new DataView(out.buffer, out.byteOffset, out.length);
    const rescan = S.webmScan(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    // seg1 verbatim 0,900 (lastTimestamp 900); seg2 offset = 900+1000=1900 -> 1900,2800
    assert(rescan.clusters.map(c => c.timestamp).join(',') === '0,900,1900,2800',
      'audio-only clusters rebased (got ' + rescan.clusters.map(c => c.timestamp) + ')');
    const infoKids = childElems(view, rescan.infoDataStart, rescan.infoDataEnd);
    const dur = infoKids.find(k => k.id === 0x4489);
    const durVal = dur ? view.getFloat64(dur.dataStart, false) : -1;
    assert(durVal > 2830 && durVal < 2900, 'Duration reflects rebased last audio block, 2800+40+33 (got ' + durVal + ')');
    const segData = rescan.segmentDataStart;
    const shSize = S.ebmlReadSize(view, segData + 4);
    const seeks = childElems(view, segData + 4 + shSize.length, segData + 4 + shSize.length + shSize.value);
    assert(seeks.length === 2, 'SeekHead has only Info+Tracks entries, no Cues (got ' + seeks.length + ')');
    let hasCuesId = false;
    for (let i = 0; i + 3 < out.length; i++) {
      if (out[i] === 0x1C && out[i+1] === 0x53 && out[i+2] === 0xBB && out[i+3] === 0x6B) { hasCuesId = true; break; }
    }
    assert(!hasCuesId, 'no video track -> no Cues element anywhere in the output');
  });

  // AO — end-to-end buffered stitch through the real save path === the oracle
  await scenario('AO real finalizeRecording stitch matches the oracle', async () => {
    const b1 = syntheticWebm(), b2 = syntheticWebm();
    const [p1, cur] = await seedSegments([b1, b2]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    assert(lastWritten.length === 1, 'one stitched file written');
    const got = Buffer.from(await lastWritten[0].arrayBuffer());
    const want = await stitchOracle([b1, b2]);
    assert(Buffer.compare(got, want) === 0, 'app buffered stitch === oracle (' + got.length + ' vs ' + want.length + ' bytes)');
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'both segments deleted after confirmed stitched save');
  });

  // ============================================================
  // Phase 1 — the streamed multi-segment stitch plan (STREAMING_STITCH_HANDOFF)
  // ============================================================
  // buildStitchPlanParts + the clusters-only scanner mode, assembled by hand
  // via streamedPlanBytes (no sinks exist yet — that's Phase 2). The invariant:
  // for ANY chunked multi-segment chain, the plan's assembled bytes must equal
  // the buffered stitchOracle byte-for-byte.

  // AP — plan-level differential (the star)
  await scenario('AP plan-level differential (streamed stitch plan matches the oracle)', async () => {
    const chains = [
      ['chrome+chrome',          () => [syntheticWebm(), syntheticWebm()]],
      ['chrome+firefox+chrome',  () => [syntheticWebm(), syntheticFirefoxWebm(), syntheticWebm()]],
      ['audio+audio',            () => [syntheticAudioOnlyWebm(), syntheticAudioOnlyWebm()]],
      // REQUIRED: a Chrome-shaped segment (1-byte 0xFF cluster markers) in
      // position 2 is the canonicalization case — a "marker-preserving" helper
      // diverges from the oracle exactly here (the oracle always canonicalizes
      // a rewritten unknown-size cluster to the 8-byte EBML_UNKNOWN_SIZE form).
      ['firefox+chrome',         () => [syntheticFirefoxWebm(), syntheticWebm()]],
    ];
    for (const [label, makeChain] of chains) {
      const oracleBuffers = makeChain();
      const want = await stitchOracle(oracleBuffers);
      let headerCount = 0;
      for (let i = 0; i + 3 < want.length; i++) {
        if (want[i] === 0x1A && want[i+1] === 0x45 && want[i+2] === 0xDF && want[i+3] === 0xA3) headerCount++;
      }
      assert(headerCount === 1, label + ': precondition — the oracle actually indexed (one EBML header, got ' + headerCount + ')');

      const splits = [
        ['whole',        b => [b]],
        ['thirds',       b => splitAt(b, [Math.floor(b.length / 3), Math.floor(2 * b.length / 3)])],
        ['midClusterId', b => splitAt(b, clusterIdOffsets(b).map(o => o + 2))],
        ['midSizeVint',  b => splitAt(b, clusterIdOffsets(b).map(o => o + 5))],
        ['midTimestamp', b => splitAt(b, clusterIdOffsets(b).map(o => o + 6))],
        ['atClusterIds', b => splitAt(b, clusterIdOffsets(b))],
        ['lastByte',     b => splitAt(b, [b.length - 1])],
        // All fixtures here are well under 1KB — every-byte chunking maximally
        // exercises pending-boundary-candidate carry states (a segment ending
        // while the carry still holds an unresolved cluster-ID candidate).
        ['everyByte',    b => splitEveryByte(b)],
      ];
      for (const [sname, splitFn] of splits) {
        const buffers = makeChain();   // fresh fixture buffers each time
        const got = await streamedPlanBytes(buffers, splitFn);
        assert(!got.bail && Buffer.compare(got, want) === 0,
          label + '/' + sname + ': streamed plan === oracle (' + (got.bail || got.length) + ' vs ' + want.length + ' bytes)');
      }
    }
  });

  // AQ — bail propagation
  await scenario('AQ bail propagation (plan-level)', async () => {
    // (a) zero-cluster segment 2 → bail with a reason, no byte-identity attempted
    {
      const result = await streamedPlanBytes([syntheticWebm(), preambleOnlyWebm()], b => [b]);
      assert(!!result.bail, 'zero-cluster segment 2 bails with a reason (got ' + JSON.stringify(result) + ')');
    }

    // (b) carry-cap bail
    try {
      sandbox.STREAM_CARRY_CAP = 32;   // absurdly small — force the bail (scenario Z's pattern)
      const result = await streamedPlanBytes([syntheticWebm(), syntheticWebm()], b => [b]);
      assert(!!result.bail, 'carry-cap exceeded bails (got ' + JSON.stringify(result) + ')');
    } finally {
      sandbox.STREAM_CARRY_CAP = ORIG_CARRY_CAP;
    }

    // Canonicalization probe: a clusters-only scan of a chrome segment (1-byte
    // 0xFF unknown-size markers) yields headerBytes whose size VINT is the
    // 8-byte EBML_UNKNOWN_SIZE pattern — independent of the oracle differential.
    {
      const chrome = syntheticWebm();
      const scanner0 = S.createWebmStreamScanner();
      scanner0.push(chrome);
      const ok0 = scanner0.finish();
      assert(ok0, 'precondition: segment 1 scan ok');
      const scan0 = scanner0.result();
      const scanner = S.createWebmStreamScanner({ clustersOnly: true, timeOffset: 3000, videoTrack: scan0.videoTrack });
      scanner.push(chrome);
      const ok = scanner.finish();
      assert(ok, 'precondition: clusters-only scan ok');
      const scan = scanner.result();
      assert(scan.clusters.length > 0, 'precondition: clusters-only scan found clusters');
      for (const c of scan.clusters) {
        const sizeBytes = Array.from(c.headerBytes.slice(4, 12));
        assert(sizeBytes.join(',') === [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF].join(','),
          'canonicalized cluster header uses the 8-byte EBML_UNKNOWN_SIZE pattern (got ' + sizeBytes.map(x => x.toString(16)).join(',') + ')');
      }
    }
  });

  // ============================================================
  // Phase 2 — sinks + wiring (STREAMING_STITCH_HANDOFF §3.3-3.5)
  // ============================================================
  // saveSessionsStreamedStitch (both sinks), stitchAndSave/recoverRecording's
  // rewired multi-segment paths, bail -> streamed parts (Rider 1), and the
  // in-app stitch-fallback banner (Rider 2, REVIEW #10) replacing confirm().

  // Seed one session per buffer, each split by splitFns[i] (defaults to the
  // same thirds split seedSegments uses when no fn is given for that index) —
  // seedSegments generalized to adversarial per-segment splits.
  async function seedSegmentsSplit(buffers, splitFns) {
    const ids = [];
    for (let i = 0; i < buffers.length; i++) {
      const fn = splitFns && splitFns[i];
      const parts = fn ? fn(buffers[i]) : splitAt(buffers[i], [Math.floor(buffers[i].length / 3), Math.floor(2 * buffers[i].length / 3)]);
      ids.push(await seedBuffers(parts));
    }
    return ids;
  }

  // AR — FSA streamed-stitch differential, end-to-end through stitchAndSave
  await scenario('AR FSA streamed-stitch differential end-to-end', async () => {
    const chains = [
      ['chrome+chrome',          () => [syntheticWebm(), syntheticWebm()],                          null],
      ['chrome+firefox+chrome',  () => [syntheticWebm(), syntheticFirefoxWebm(), syntheticWebm()],   null],
      ['audio+audio',            () => [syntheticAudioOnlyWebm(), syntheticAudioOnlyWebm()],         null],
      // Adversarial splits on the canonicalization chain: cluster-ID-boundary
      // splits on segment 1, every-byte on segment 2.
      ['firefox+chrome',         () => [syntheticFirefoxWebm(), syntheticWebm()],
        (buffers) => [(b) => splitAt(b, clusterIdOffsets(b)), (b) => splitEveryByte(b)]],
    ];
    for (const [label, makeChain, splitFnsFactory] of chains) {
      const buffers = makeChain();
      const want = await stitchOracle(buffers);
      const splitFns = splitFnsFactory ? splitFnsFactory(buffers) : null;
      const ids = await seedSegmentsSplit(buffers, splitFns);
      const last = ids[ids.length - 1];
      const priors = ids.slice(0, -1);
      state.priorSegments = priors.map((id) => ({ sessionId: id, mimeType: 'video/webm' }));
      state.sessionId = last; state.chunkIndex = 1;
      windowMock.showSaveFilePicker = pickerSequence(['ok']);
      await api.stitchAndSave('video/webm');
      await drain();
      assert(lastWritten.length === 1, label + ': one stitched file written');
      const got = Buffer.from(await lastWritten.pop().arrayBuffer());
      assert(Buffer.compare(got, want) === 0, label + ': streamed stitch === oracle (' + got.length + ' vs ' + want.length + ' bytes)');
      const sessions = await readStore('sessions');
      assert(sessions.length === 0, label + ': all sessions deleted');
      assert(state.priorSegments.length === 0, label + ': priorSegments cleared');
    }
  });

  // AS — download streamed-stitch differential, end-to-end through stitchAndSave
  await scenario('AS download streamed-stitch differential', async () => {
    const chains = [
      ['chrome+chrome',          () => [syntheticWebm(), syntheticWebm()]],
      ['chrome+firefox+chrome',  () => [syntheticWebm(), syntheticFirefoxWebm(), syntheticWebm()]],
      ['audio+audio',            () => [syntheticAudioOnlyWebm(), syntheticAudioOnlyWebm()]],
      ['firefox+chrome',         () => [syntheticFirefoxWebm(), syntheticWebm()]],
    ];
    for (const [label, makeChain] of chains) {
      const buffers = makeChain();
      const want = await stitchOracle(buffers);
      const ids = await seedSegments(buffers);   // AR already covers adversarial splits; thirds is enough here
      const last = ids[ids.length - 1];
      const priors = ids.slice(0, -1);
      state.priorSegments = priors.map((id) => ({ sessionId: id, mimeType: 'video/webm' }));
      state.sessionId = last; state.chunkIndex = 3;
      delete windowMock.showSaveFilePicker;   // Firefox mode
      const clicksBefore = downloadClicks.length;
      await api.stitchAndSave('video/webm');
      await drain();
      assert(downloadClicks.length === clicksBefore + 1, label + ': one stitched download fired');
      const got = Buffer.from(await objectUrlBlobs[objectUrlBlobs.length - 1].arrayBuffer());
      assert(Buffer.compare(got, want) === 0, label + ': composed download === oracle');
      let sessions = await readStore('sessions');
      const allIds = [...priors, last];
      assert(allIds.every(id => sessions.some(s => s.id === id)), label + ': nothing deleted before confirm');
      assert(documentMock.getElementById('downloadConfirm').classList.contains('visible'), label + ': confirm bar visible');
      assert(allIds.every(id => sandbox.downloadPendingIds.includes(id)), label + ': downloadPendingIds covers all segments');
      await sandbox.confirmDownloadArrived();
      await drain();
      sessions = await readStore('sessions');
      assert(allIds.every(id => !sessions.some(s => s.id === id)), label + ': all sessions deleted after confirm');
    }
  });

  // AT — FSA picker cancel = zero work
  await scenario('AT FSA picker cancel is zero work', async () => {
    const [p1, cur] = await seedSegments([syntheticWebm(), syntheticWebm()]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['abort']);
    await api.stitchAndSave('video/webm');
    await drain();
    assert(writeCalls.length === 0, 'no writes attempted');
    assert(closedFiles === 0, 'no file closed');
    const sessions = await readStore('sessions');
    assert(sessions.length === 2, 'both sessions intact (got ' + sessions.length + ')');
    const chunks = await readStore('chunks');
    assert(chunks.length === 6, 'chunks intact (got ' + chunks.length + ')');
    assert(recordedErrors.some(m => /preserved|reload/i.test(m)), 'cancel messaging surfaced');
  });

  // AU — FSA mid-write failure -> abort, sessions kept, in-app fallback offered
  await scenario('AU FSA mid-write failure aborts and offers the in-app fallback', async () => {
    const [p1, cur] = await seedSegments([syntheticWebm(), syntheticWebm()]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    failWriteAfter = 2;
    await api.stitchAndSave('video/webm');
    await drain();
    assert(abortCalls === 1, 'writable.abort() called (got ' + abortCalls + ')');
    assert(closedFiles === 0 && lastWritten.length === 0, 'no file finalized');
    const sessions = await readStore('sessions');
    assert(sessions.length === 2, 'both sessions kept after failed write (got ' + sessions.length + ')');
    assert(documentMock.getElementById('stitchFallback').classList.contains('visible'), 'stitch fallback banner shown');
    sandbox.stitchFallbackKeep();
    assert(!documentMock.getElementById('stitchFallback').classList.contains('visible'), 'banner hidden after keep');
    const sessions2 = await readStore('sessions');
    assert(sessions2.length === 2, 'sessions still intact after keep');
  });

  // AV — bail routes through the in-app fallback buttons, not confirm() (REVIEW #10)
  await scenario('AV bail routes through the in-app fallback, not confirm()', async () => {
    const b1 = syntheticWebm();
    const [p1, cur] = await seedSegments([b1, preambleOnlyWebm()]);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    // If this reached the old confirm(), it would throw — confirm is
    // undefined in this sandbox. Green here proves the replacement is wired.
    await api.stitchAndSave('video/webm');
    await drain();
    assert(documentMock.getElementById('stitchFallback').classList.contains('visible'), 'stitch fallback banner shown on bail');
    let sessions = await readStore('sessions');
    assert(sessions.length === 2, 'both sessions intact after bail (got ' + sessions.length + ')');

    // Reference: what a lone v1.11 streamed single save produces for segment
    // 1's own buffer (same deterministic thirds split as seedSegments used above).
    const [refId] = await seedSegments([b1]);
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    const refResult = await S.saveFile({ kind: 'session', sessionId: refId, mimeType: 'video/webm' });
    assert(refResult === 'saved', 'reference single save succeeded');
    assert(lastWritten.length === 1, 'reference save wrote one file');
    const refBytes = Buffer.from(await lastWritten.pop().arrayBuffer());
    await api.deleteSession(refId);

    windowMock.showSaveFilePicker = pickerSequence(['ok', 'ok']);
    // stitchFallbackSaveParts() is void (it drives UI state, not a return
    // value) — verify through the same side effects AT/AU use: writes, store
    // contents, and the banner.
    await sandbox.stitchFallbackSaveParts();
    await drain();
    assert(lastWritten.length === 2, 'two part files written (got ' + lastWritten.length + ')');
    const part1Bytes = Buffer.from(await lastWritten[0].arrayBuffer());
    assert(Buffer.compare(part1Bytes, refBytes) === 0, 'part 1 bytes identical to a lone v1.11 streamed save');
    sessions = await readStore('sessions');
    assert(sessions.length === 0, 'both parts deleted after saving');
    assert(!documentMock.getElementById('stitchFallback').classList.contains('visible'), 'banner stays hidden through the parts flow');

    // Keep-variant: a fresh bail, choosing "keep" instead of "save as parts".
    const [p1b, curb] = await seedSegments([syntheticWebm(), preambleOnlyWebm()]);
    state.priorSegments = [{ sessionId: p1b, mimeType: 'video/webm' }];
    state.sessionId = curb; state.chunkIndex = 3;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.stitchAndSave('video/webm');
    await drain();
    assert(documentMock.getElementById('stitchFallback').classList.contains('visible'), 'banner shown on the fresh bail');
    sandbox.stitchFallbackKeep();
    assert(!documentMock.getElementById('stitchFallback').classList.contains('visible'), 'banner hidden after keep');
    const sessions2 = await readStore('sessions');
    assert(sessions2.length === 2, 'sessions kept after choosing keep (got ' + sessions2.length + ')');
    assert(recordedErrors.some(m => /safe in the browser/i.test(m)), 'faculty message recorded');
  });

  // AW — recoverRecording streamed stitch
  await scenario('AW recoverRecording streamed stitch', async () => {
    // (a) clean chain -> streamed stitch === oracle, banner cleared
    {
      const b1 = syntheticWebm(), b2 = syntheticWebm(), b3 = syntheticAudioOnlyWebm();
      const ids = await seedSegments([b1, b2, b3]);
      windowMock._recoverySessions = ids.map(id => ({ id, mimeType: 'video/webm' }));
      const want = await stitchOracle([b1, b2, b3]);
      windowMock.showSaveFilePicker = pickerSequence(['ok']);
      await api.recoverRecording();
      await drain();
      assert(lastWritten.length === 1, 'one stitched file written');
      const got = Buffer.from(await lastWritten.pop().arrayBuffer());
      assert(Buffer.compare(got, want) === 0, 'recovery streamed stitch === oracle');
      const sessions = await readStore('sessions');
      assert(sessions.length === 0, 'all sessions deleted');
      assert(!documentMock.getElementById('recoveryBanner').classList.contains('visible'), 'recovery banner hidden');
    }

    // (b) bail (zero-cluster middle segment) -> auto parts fallback, NOT the
    // in-app stitchFallback banner — recovery auto-proceeds, same pattern as
    // today, just streamed instead of buffered.
    {
      const ids = await seedSegments([syntheticWebm(), preambleOnlyWebm(), syntheticWebm()]);
      windowMock._recoverySessions = ids.map(id => ({ id, mimeType: 'video/webm' }));
      windowMock.showSaveFilePicker = pickerSequence(['ok']);
      await api.recoverRecording();
      await drain();
      assert(recordedErrors.some(m => /Could not stitch/i.test(m)), '"Could not stitch" message recorded');
      assert(!documentMock.getElementById('stitchFallback').classList.contains('visible'), 'no stitchFallback banner on recovery bail');
      assert(lastWritten.length === 3, 'three parts saved (got ' + lastWritten.length + ')');
      const sessions = await readStore('sessions');
      assert(sessions.length === 0, 'all parts deleted');
      assert(!documentMock.getElementById('recoveryBanner').classList.contains('visible'), 'recovery banner hidden after parts save');
    }
  });

  // Known-size (not unknown-size) clusters — for AX's truncated-final-cluster
  // bail. Reuses the clusterKnown/el/simpleBlock builders scenario P and
  // syntheticPoisonWebm establish.
  function knownSizeClusterWebm() {
    function clusterKnown(ts, blocks) {
      const data = Buffer.concat([el([0xE7], uintBytes(ts, 2)), ...blocks]);
      return Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), sizeVint(data.length), data]);
    }
    const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]);
    const segHdr = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const infoEl = el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], uintBytes(1000000, 3)));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B],
      el([0xAE], el([0xD7], [0x01]), el([0x83], [0x01])),
      el([0xAE], el([0xD7], [0x02]), el([0x83], [0x02])));
    const c0 = clusterKnown(0,    [simpleBlock(1, 0, 0x80, 40), simpleBlock(2, 5, 0x80, 10)]);
    const c1 = clusterKnown(1000, [simpleBlock(1, 0, 0x80, 40), simpleBlock(1, 500, 0x00, 30)]);
    return Buffer.concat([header, segHdr, infoEl, tracks, c0, c1]);
  }

  // AX — truncated-known-size final cluster: bail in a chain, tolerated alone
  // (queued Phase 2 note; generalizes §6 gotcha #3 from unknown-size to
  // known-size). The clusters-only scanner (segments 2..N) bails on a
  // truncated known-size final cluster; the v1.11 single-segment scanner
  // (segment 1, or any lone save) clamps and tolerates it — scenario M's
  // shape. Same bytes, intentionally different outcome by position in the chain.
  await scenario('AX truncated known-size final cluster: bail in a chain, tolerated alone', async () => {
    const full = knownSizeClusterWebm();
    const truncated = full.slice(0, -10);   // still well inside c1's payload

    // Contrast case: the SAME truncated buffer, saved ALONE via the v1.11
    // streamed path, still saves (clamped tolerance, no bail) — scenario-M-style.
    {
      const id = await seedBuffers([truncated]);
      windowMock.showSaveFilePicker = pickerSequence(['ok']);
      const r = await S.saveFile({ kind: 'session', sessionId: id, mimeType: 'video/webm' });
      assert(r === 'saved', 'lone truncated segment still saves (v1.11 tolerance)');
      assert(lastWritten.length === 1, 'one file written for the lone save');
      lastWritten.pop();
      await api.deleteSession(id);   // saveFile doesn't delete on its own — clean up before the chain case below
    }

    // As segment 2 of a chain, the same truncated bytes drive the
    // clusters-only scanner's stricter guard -> bail, fallback banner offered.
    {
      const p1 = (await seedSegments([syntheticWebm()]))[0];
      const cur = await seedBuffers([truncated]);
      state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }];
      state.sessionId = cur; state.chunkIndex = 1;
      windowMock.showSaveFilePicker = pickerSequence(['ok']);
      await api.stitchAndSave('video/webm');
      await drain();
      assert(documentMock.getElementById('stitchFallback').classList.contains('visible'), 'bail -> stitch fallback banner visible');
      const sessions = await readStore('sessions');
      assert(sessions.length === 2, 'both sessions intact after bail');
      sandbox.stitchFallbackKeep();
    }
  });

  // ============================================================
  // Mic label priming (v1.13) — enumerateDevices() skips blank-deviceId
  // placeholders; primeMicLabels() is the mic's early grant path
  // ============================================================
  await scenario('AY pre-grant enumeration (blank deviceId) yields only the Default option in both dropdowns', async () => {
    // DOM element mocks persist across scenarios (AF leaves real camera
    // options behind) — a genuinely empty device list is unambiguous
    // removal, not anonymization, so this always rebuilds to Default-only
    // and gives us a clean pre-grant starting point for the real assertion.
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();

    mockDevices = [
      { kind: 'videoinput', deviceId: '', label: '' },
      { kind: 'audioinput', deviceId: '', label: '' },
    ];
    await sandbox.enumerateDevices();
    await drain();

    const camSelect = documentMock.getElementById('cameraSelect');
    const micSelect = documentMock.getElementById('micSelect');
    assert(camSelect.innerHTML === '<option value="">Default camera</option>', 'camera dropdown is just the Default option, no fake placeholder appended (got: ' + camSelect.innerHTML + ')');
    assert(micSelect.innerHTML === '<option value="">Default microphone</option>', 'mic dropdown is just the Default option, no fake placeholder appended (got: ' + micSelect.innerHTML + ')');
    assert(camSelect.querySelectorAll('option[value]').length === 0, 'no camera option objects were appended beyond the Default (got ' + camSelect.querySelectorAll('option[value]').length + ')');
    assert(micSelect.querySelectorAll('option[value]').length === 0, 'no mic option objects were appended beyond the Default (got ' + micSelect.querySelectorAll('option[value]').length + ')');
  });

  await scenario('AZ post-grant enumeration populates real options; selecting one feeds the deviceId constraint', async () => {
    mockDevices = [
      { kind: 'videoinput', deviceId: 'cam1', label: 'Logitech BRIO' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' },
    ];
    await sandbox.enumerateDevices();
    await drain();

    const camSelect = documentMock.getElementById('cameraSelect');
    const micSelect = documentMock.getElementById('micSelect');
    const camOpt = camSelect.querySelector('option[value="cam1"]');
    const micOpt = micSelect.querySelector('option[value="mic1"]');
    assert(camOpt && camOpt.textContent === 'Logitech BRIO', 'real camera option populated (got: ' + (camOpt && camOpt.textContent) + ')');
    assert(micOpt && micOpt.textContent === 'USB Mic', 'real mic option populated (got: ' + (micOpt && micOpt.textContent) + ')');

    micSelect.value = 'mic1';
    sandbox.onDeviceSelected('mic');
    assert(state.selectedMic === 'mic1', 'selecting the option updates state.selectedMic');

    await sandbox.captureMic();
    const call = getUserMediaCalls[getUserMediaCalls.length - 1];
    assert(call.audio && call.audio.deviceId && call.audio.deviceId.exact === 'mic1', 'the selected deviceId reaches the getUserMedia constraint (got: ' + JSON.stringify(call.audio) + ')');
  });

  await scenario('BA acquireMicHold grants, enumerates while the stream is still live, and does NOT stop the tracks (the hold)', async () => {
    // DOM element mocks persist across scenarios — start from a clean,
    // not-yet-upgraded dropdown so nothing here depends on state left by an
    // earlier scenario.
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true; // acquireMicHold bails without holding if the toggle isn't on

    const order = [];
    const track = { kind: 'audio', readyState: 'live', stop() { order.push('stop'); } };
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      order.push('getUserMedia');
      return makeStream([track]);
    };
    sandbox.navigator.mediaDevices.enumerateDevices = async () => { order.push('enumerate'); return mockDevices; };
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];

    await sandbox.acquireMicHold();

    assert(getUserMediaCalls.length === 1, 'getUserMedia called once (got ' + getUserMediaCalls.length + ')');
    assert(getUserMediaCalls[0].audio && getUserMediaCalls[0].audio.echoCancellation === true && getUserMediaCalls[0].video === false, 'full recording-quality audio constraints, not a bare audio:true probe (got: ' + JSON.stringify(getUserMediaCalls[0]) + ')');
    assert(order.join(',') === 'getUserMedia,enumerate', 'enumerate runs while the stream is live, and the tracks are never stopped (got: ' + order.join(',') + ')');

    const micOpt = documentMock.getElementById('micSelect').querySelector('option[value="mic1"]');
    assert(micOpt && micOpt.textContent === 'USB Mic', 'real label landed via the hold\'s enumerate (got: ' + (micOpt && micOpt.textContent) + ')');
    assert(state.heldMicStream && state.heldMicStream.getAudioTracks()[0] === track, 'the granted stream is held in state.heldMicStream');
    assert(state.heldMicDeviceId === state.selectedMic, 'heldMicDeviceId records the selection the hold was acquired under');
  });

  await scenario('BB acquireMicHold always re-acquires on toggle-ON, even when real mic options already exist (it holds a STREAM now, not just labels)', async () => {
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true;

    await sandbox.acquireMicHold();
    assert(getUserMediaCalls.length === 1, 'v1.14\'s "labels already upgraded, skip" guard is gone — the toggle needs a live stream to hold, not just names (got ' + getUserMediaCalls.length + ')');
    assert(state.heldMicStream !== null, 'a hold was acquired');
  });

  await scenario('BC acquireMicHold failure path reverts the toggle and shows a friendly error, without throwing', async () => {
    mockDevices = []; // reset to placeholder-only state
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true;

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e;
    };

    let threw = false;
    try { await sandbox.acquireMicHold(); } catch (e) { threw = true; }

    assert(!threw, 'acquireMicHold swallows the rejection (no throw)');
    assert(getUserMediaCalls.length === 1, 'getUserMedia was attempted (got ' + getUserMediaCalls.length + ')');
    assert(state.sources.mic === false, 'the toggle is reverted to off after a denied grant (got ' + state.sources.mic + ')');
    assert(state.heldMicStream === null, 'no hold exists after a denied grant');
    assert(recordedErrors.some(m => /declined|denied/i.test(m) && /toggle/i.test(m)), 'a friendly message tells the user to toggle the mic on again (got: ' + JSON.stringify(recordedErrors) + ')');
    const micSelect = documentMock.getElementById('micSelect');
    assert(micSelect.innerHTML === '<option value="">Default microphone</option>', 'dropdown still just Default microphone after a failed grant (got: ' + micSelect.innerHTML + ')');
  });

  await scenario('BD the passive mousedown/focus mic-select prime is gone in v1.16 — those events no longer touch getUserMedia at all', async () => {
    mockDevices = []; // clean, not-yet-upgraded state
    await sandbox.enumerateDevices();
    await drain();
    // Toggle stays off (default) — mirrors reality, since #micSelect is only
    // enabled while the toggle is on (see updateToggleUI), and by then
    // acquireMicHold has already run via the toggle-ON click itself.
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];
    dispatchEl('micSelect', 'mousedown');
    dispatchEl('micSelect', 'focus');
    await drain();

    assert(getUserMediaCalls.length === 0, 'mousedown/focus on #micSelect no longer prime anything — v1.16 removed the passive listeners as redundant dead code (got ' + getUserMediaCalls.length + ')');
  });

  // ============================================================
  // Chrome acceptance fixes — re-entrancy guard on acquireMicHold(), and the
  // anonymized-list guard on enumerateDevices()
  // ============================================================
  await scenario('BE overlapping acquireMicHold calls make only one getUserMedia call (in-flight guard)', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true;

    let resolveGUM;
    const gumPromise = new Promise((res) => { resolveGUM = res; });
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return gumPromise; // stays unresolved until manually resolved below
    };
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];

    // acquireMicHold runs synchronously up to its `await getUserMedia(...)`
    // — by the time this line returns, micHoldInFlight is already true and
    // the (single) getUserMedia call has already been made.
    const p1 = sandbox.acquireMicHold();
    const p2 = sandbox.acquireMicHold(); // fires while p1's grant is still unresolved (e.g. a rapid double toggle-click)

    assert(getUserMediaCalls.length === 1, 'only one getUserMedia call while the first is still in flight (got ' + getUserMediaCalls.length + ')');

    resolveGUM(makeStream([{ kind: 'audio', readyState: 'live', stop() {} }]));
    await p1;
    await p2;
    await drain();

    assert(getUserMediaCalls.length === 1, 'still exactly one getUserMedia call once both settle (got ' + getUserMediaCalls.length + ')');
    const micOpt = documentMock.getElementById('micSelect').querySelector('option[value="mic1"]');
    assert(micOpt && micOpt.textContent === 'USB Mic', 'the single grant still upgraded the label (got: ' + (micOpt && micOpt.textContent) + ')');
    assert(state.heldMicStream !== null, 'the single grant is held');
  });

  await scenario('BF anonymized re-enumeration (entries present, ids blank) preserves a granted list; genuine removal still rebuilds', async () => {
    // Establish a granted list for both kinds.
    mockDevices = [
      { kind: 'videoinput', deviceId: 'cam1', label: 'Logitech BRIO' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' },
    ];
    await sandbox.enumerateDevices();
    await drain();
    const camSelect = documentMock.getElementById('cameraSelect');
    const micSelect = documentMock.getElementById('micSelect');
    camSelect.value = 'cam1';
    micSelect.value = 'mic1';

    // Anonymized re-enumeration: entries present for both kinds, but every
    // deviceId is blank (permission lapsed, e.g. a file:// origin that
    // doesn't persist the grant) — not a genuine unplug.
    mockDevices = [
      { kind: 'videoinput', deviceId: '', label: '' },
      { kind: 'audioinput', deviceId: '', label: '' },
    ];
    await sandbox.enumerateDevices();
    await drain();

    assert(camSelect.querySelector('option[value="cam1"]') && camSelect.querySelector('option[value="cam1"]').textContent === 'Logitech BRIO', 'camera keeps its granted list through an anonymized re-enumerate');
    assert(micSelect.querySelector('option[value="mic1"]') && micSelect.querySelector('option[value="mic1"]').textContent === 'USB Mic', 'mic keeps its granted list through an anonymized re-enumerate');
    assert(camSelect.value === 'cam1', 'camera selection untouched by the skipped rebuild (got: ' + camSelect.value + ')');
    assert(micSelect.value === 'mic1', 'mic selection untouched by the skipped rebuild (got: ' + micSelect.value + ')');

    // A third enumerate with a genuinely different real list still rebuilds normally.
    mockDevices = [
      { kind: 'videoinput', deviceId: 'cam2', label: 'External webcam' },
      { kind: 'audioinput', deviceId: 'mic2', label: 'Headset mic' },
    ];
    await sandbox.enumerateDevices();
    await drain();
    assert(camSelect.querySelector('option[value="cam2"]') && camSelect.querySelector('option[value="cam2"]').textContent === 'External webcam', 'a real, different list still rebuilds the camera dropdown');
    assert(micSelect.querySelector('option[value="mic2"]') && micSelect.querySelector('option[value="mic2"]').textContent === 'Headset mic', 'a real, different list still rebuilds the mic dropdown');
    assert(camSelect.querySelector('option[value="cam1"]') === null, 'the stale cam1 option is gone after the real rebuild');
    assert(micSelect.querySelector('option[value="mic1"]') === null, 'the stale mic1 option is gone after the real rebuild');

    // Genuine removal (no audioinput entries at all) still rebuilds — existing unplug semantics.
    mockDevices = [
      { kind: 'videoinput', deviceId: 'cam2', label: 'External webcam' },
      // no audioinput entries at all
    ];
    await sandbox.enumerateDevices();
    await drain();
    assert(micSelect.innerHTML === '<option value="">Default microphone</option>', 'mic dropdown drops to Default-only on genuine removal (got: ' + micSelect.innerHTML + ')');
  });

  await scenario('BG each toggle-ON click is a fresh attempt — no attempted-once suppression survives a denial (v1.14 had one; v1.16 doesn\'t need it since denial reverts the toggle)', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false }; // deterministic starting toggle state — resetState() doesn't touch state.sources

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e;
    };

    sandbox.toggleSource('mic'); // toggle ON -> acquireMicHold -> denied -> reverts to off
    await drain();
    assert(getUserMediaCalls.length === 1, 'first toggle-ON attempts getUserMedia (got ' + getUserMediaCalls.length + ')');
    assert(state.sources.mic === false, 'denial reverted the toggle');

    sandbox.toggleSource('mic'); // toggle ON again — a fresh attempt, no "attempted once" flag to suppress it
    await drain();
    assert(getUserMediaCalls.length === 2, 'a second toggle-ON click retries with no leftover suppression (got ' + getUserMediaCalls.length + ')');
  });

  // ============================================================
  // Graceful degradation for environments that can never list mic devices
  // (file://-served Chrome — the grant succeeds but enumeration stays
  // anonymized forever; the granted track's own .label is all we get)
  // ============================================================
  await scenario('BH a completed grant+enumerate that stays blank-id sets the flag and explains the placeholder', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true;

    // Grant succeeds (getUserMedia resolves) but the environment can only
    // ever report a blank-id audioinput — file://-served Chrome, per the
    // field report.
    mockDevices = [{ kind: 'audioinput', deviceId: '', label: '' }];
    await sandbox.acquireMicHold();

    assert(getUserMediaCalls.length === 1, 'the grant was attempted (got ' + getUserMediaCalls.length + ')');
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === '1', 'flag persisted after a completed grant+enumerate that yielded no real options');
    const defaultOpt = documentMock.getElementById('micSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Chosen in the browser pop-up', 'placeholder explains where selection really happens (got: ' + (defaultOpt && defaultOpt.textContent) + ')');
    assert(state.heldMicStream !== null, 'the stream is still held even though the environment cannot name it');
  });

  // v1.16 BEHAVIOR CHANGE: v1.15's primeMicLabels suppressed BOTH the passive
  // and forced toggle-time prompt once micEnumAnonymized was set, because
  // that prompt's grant evaporated before Record and bought nothing. Now the
  // toggle-time prompt is the setup step that acquires the HELD stream
  // recording depends on — suppressing it would silently bring back the
  // record-time prompt in exactly the anonymized environments this feature
  // targets. So toggle-ON must keep prompting every time regardless of the
  // flag; the flag's only remaining job is the Default-slot text.
  await scenario('BI with micEnumAnonymized already set, toggle-ON still prompts (once) and still acquires a hold — the flag only controls the Default-slot text now', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false }; // deterministic starting toggle state — resetState() doesn't touch state.sources
    sandbox.localStorage.setItem('micEnumAnonymized', '1'); // environment already proved it can't deliver names, from an earlier session

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', readyState: 'live', label: 'USB Mic', stop() {} }]);
    };
    mockDevices = [{ kind: 'audioinput', deviceId: '', label: '' }]; // still can't enumerate real ids

    sandbox.toggleSource('mic'); // the toggle-ON click — IS the setup step now, flag or no flag
    await drain();

    assert(getUserMediaCalls.length === 1, 'toggle-ON prompts exactly once even with the anonymized flag already set (got ' + getUserMediaCalls.length + ')');
    assert(state.heldMicStream !== null, 'the grant is held — this prompt is not a wasted nag anymore');
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === '1', 'the flag stays set (this environment still can\'t enumerate) — it never gated whether to prompt, only the Default-slot text');
    const defaultOpt = documentMock.getElementById('micSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Microphone: USB Mic', 'Default-slot text still prefers the granted track\'s own label over the generic anonymized copy (got: ' + (defaultOpt && defaultOpt.textContent) + ')');

    // And if the environment recovers (real ids come back), the flag clears
    // exactly as before — that escape hatch is unchanged.
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];
    await sandbox.enumerateDevices();
    await drain();
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === null, 'a real-option rebuild still clears the flag');
  });

  await scenario('BJ captureMic surfaces the granted track\'s own label when there are no real options, and it survives an anonymized re-enumerate', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();

    // No real options available; the granted stream's track still knows its own name.
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', label: 'USB Mic', stop() {} }]);
    };
    await sandbox.captureMic();
    await drain();

    let defaultOpt = documentMock.getElementById('micSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Microphone: USB Mic', 'Default option shows the granted track\'s own label (got: ' + (defaultOpt && defaultOpt.textContent) + ')');

    // A later anonymized re-enumeration (entries present, blank ids) must not wipe this —
    // e.g. devicechange firing right after recording stops.
    mockDevices = [{ kind: 'audioinput', deviceId: '', label: '' }];
    await sandbox.enumerateDevices();
    await drain();

    defaultOpt = documentMock.getElementById('micSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Microphone: USB Mic', 'text survives a later anonymized re-enumeration (got: ' + (defaultOpt && defaultOpt.textContent) + ')');
  });

  await scenario('BK environments with real options: captureMic does not overwrite the dropdown, and the flag stays unset', async () => {
    mockDevices = [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }];
    await sandbox.enumerateDevices();
    await drain();
    const micSelect = documentMock.getElementById('micSelect');
    micSelect.value = 'mic1';

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', label: 'Some Other Mic', stop() {} }]);
    };
    await sandbox.captureMic();
    await drain();

    const micOpt = micSelect.querySelector('option[value="mic1"]');
    assert(micOpt && micOpt.textContent === 'USB Mic', 'real option/label untouched by captureMic (got: ' + (micOpt && micOpt.textContent) + ')');
    assert(micSelect.value === 'mic1', 'selection untouched (got: ' + micSelect.value + ')');
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === null, 'flag stays unset when real options exist');
    assert(state.lastMicLabel === null, 'lastMicLabel is not set when real options already exist (got: ' + state.lastMicLabel + ')');
  });

  // ============================================================
  // v1.15 — camera-side honest labels (generalized applyDeviceDefaultText,
  // camEnumAnonymized as its own flag), mirroring the mic machinery above.
  // ============================================================
  await scenario('BL captureCamera surfaces the granted track\'s own label when there are no real options, and it survives an anonymized re-enumerate', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();

    // No real options available; the granted stream's track still knows its own name.
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'video', label: 'HD Webcam', stop() {} }]);
    };
    await sandbox.captureCamera();
    await drain();

    let defaultOpt = documentMock.getElementById('cameraSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Camera: HD Webcam', 'Default option shows the granted track\'s own label (got: ' + (defaultOpt && defaultOpt.textContent) + ')');

    // A later anonymized re-enumeration (entries present, blank ids) must not wipe this —
    // e.g. devicechange firing right after the camera preview stops.
    mockDevices = [{ kind: 'videoinput', deviceId: '', label: '' }];
    await sandbox.enumerateDevices();
    await drain();

    defaultOpt = documentMock.getElementById('cameraSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Camera: HD Webcam', 'text survives a later anonymized re-enumeration (got: ' + (defaultOpt && defaultOpt.textContent) + ')');
  });

  await scenario('BM environments with real camera options: captureCamera does not overwrite the dropdown, and camEnumAnonymized stays unset', async () => {
    mockDevices = [{ kind: 'videoinput', deviceId: 'cam1', label: 'Logitech BRIO' }];
    await sandbox.enumerateDevices();
    await drain();
    const camSelect = documentMock.getElementById('cameraSelect');
    camSelect.value = 'cam1';

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'video', label: 'Some Other Camera', stop() {} }]);
    };
    await sandbox.captureCamera();
    await drain();

    const camOpt = camSelect.querySelector('option[value="cam1"]');
    assert(camOpt && camOpt.textContent === 'Logitech BRIO', 'real option/label untouched by captureCamera (got: ' + (camOpt && camOpt.textContent) + ')');
    assert(camSelect.value === 'cam1', 'selection untouched (got: ' + camSelect.value + ')');
    assert(sandbox.localStorage.getItem('camEnumAnonymized') === null, 'camera flag stays unset when real options exist');
    assert(state.lastCameraLabel === null, 'lastCameraLabel is not set when real options already exist (got: ' + state.lastCameraLabel + ')');
  });

  await scenario('BN a completed camera grant+enumerate that stays blank-id sets camEnumAnonymized and explains the placeholder', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();

    // Grant succeeds (getUserMedia resolves) but the environment can only
    // ever report a blank-id videoinput — file://-served Chrome, same as the
    // mic field report, extended to the camera.
    mockDevices = [{ kind: 'videoinput', deviceId: '', label: '' }];
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'video', stop() {} }]); // no label either — worst case
    };
    await sandbox.captureCamera();
    await drain();

    assert(getUserMediaCalls.length === 1, 'the grant was attempted (got ' + getUserMediaCalls.length + ')');
    assert(sandbox.localStorage.getItem('camEnumAnonymized') === '1', 'flag persisted after a completed grant+enumerate that yielded no real options');
    const defaultOpt = documentMock.getElementById('cameraSelect').querySelector('option[value=""]');
    assert(defaultOpt && defaultOpt.textContent === 'Chosen in the browser pop-up', 'placeholder explains where selection really happens (got: ' + (defaultOpt && defaultOpt.textContent) + ')');
  });

  await scenario('BO mic and camera anonymized verdicts are tracked independently', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();

    // Camera-only anonymized grant: a completed grant+enumerate stays blank-id.
    mockDevices = [{ kind: 'videoinput', deviceId: '', label: '' }];
    await sandbox.captureCamera();
    await drain();
    assert(sandbox.localStorage.getItem('camEnumAnonymized') === '1', 'camera verdict set after a blank-id grant+enumerate');
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === null, 'mic verdict untouched by a camera-only anonymized grant (got: ' + sandbox.localStorage.getItem('micEnumAnonymized') + ')');

    // Mic-only anonymized grant, via acquireMicHold: stays blank-id too — the
    // already-set camera verdict must survive untouched.
    state.sources.mic = true;
    mockDevices = [{ kind: 'audioinput', deviceId: '', label: '' }];
    await sandbox.acquireMicHold();
    assert(sandbox.localStorage.getItem('micEnumAnonymized') === '1', 'mic verdict set independently');
    assert(sandbox.localStorage.getItem('camEnumAnonymized') === '1', 'camera verdict survives an unrelated mic grant (got: ' + sandbox.localStorage.getItem('camEnumAnonymized') + ')');
  });

  // ============================================================
  // v1.15 — mic toggle defaults OFF at load (matching the webcam)
  // ============================================================
  await scenario('BP mic defaults off at load, matching the webcam', async () => {
    assert(INITIAL_SOURCES_MIC === false, 'state.sources.mic\'s script-load default is false (got ' + INITIAL_SOURCES_MIC + ')');
  });

  await scenario('BQ mic select is disabled while the mic toggle is off, and toggling mic on is the priming gesture (zero prompts at load still holds)', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    assert(getUserMediaCalls.length === 0, 'zero prompts at load even after an explicit enumerate');

    state.sources = { screen: true, camera: false, mic: false };
    sandbox.updateToggleUI();
    assert(documentMock.getElementById('micSelect').disabled === true, 'mic select disabled while the toggle is off');
    assert(getUserMediaCalls.length === 0, 'syncing the UI for mic-off still makes no getUserMedia call');

    sandbox.toggleSource('mic'); // the explicit toggle-ON click — a user gesture
    await drain();
    assert(state.sources.mic === true, 'mic toggle turned on');
    assert(documentMock.getElementById('micSelect').disabled === false, 'mic select re-enabled once the toggle is on');
    assert(getUserMediaCalls.length === 1, 'toggle-ON is the acquire-hold gesture: exactly one getUserMedia call (got ' + getUserMediaCalls.length + ')');
    // v1.16: this is no longer a throwaway audio:true label probe — it's the
    // real recording-quality grant, since the stream now gets HELD and reused
    // at record time (see acquireMicHold / micAudioConstraints).
    assert(getUserMediaCalls[0].video === false, 'video: false (got: ' + JSON.stringify(getUserMediaCalls[0]) + ')');
    assert(getUserMediaCalls[0].audio && getUserMediaCalls[0].audio.echoCancellation === true && getUserMediaCalls[0].audio.noiseSuppression === true, 'full recording-quality audio constraints from the toggle-ON hold (got: ' + JSON.stringify(getUserMediaCalls[0].audio) + ')');
    assert(state.heldMicStream !== null, 'the toggle-ON grant is held, not stopped, for record-time reuse');
  });

  await scenario('BR the record button guard is unaffected by mic defaulting off — screen/camera decide, not mic', async () => {
    state.sources = { screen: true, camera: false, mic: false };
    state.screenStream = null;
    sandbox.updateRecordButton();
    assert(documentMock.getElementById('btnRecord').disabled === true, 'no screen stream yet -> disabled, even with mic off (the default now)');

    state.screenStream = makeStream([{ kind: 'video', stop() {} }]);
    sandbox.updateRecordButton();
    assert(documentMock.getElementById('btnRecord').disabled === false, 'screen stream present -> enabled, even though mic is off');

    // Camera-only mode (screen off) is always enabled regardless of mic too.
    state.sources = { screen: false, camera: true, mic: false };
    state.screenStream = null;
    sandbox.updateRecordButton();
    assert(documentMock.getElementById('btnRecord').disabled === false, 'camera-only mode enabled regardless of mic (got disabled=' + documentMock.getElementById('btnRecord').disabled + ')');
  });

  // ============================================================
  // v1.16 — held mic stream (toggle-ON acquires and KEEPS the mic, mirroring
  // the webcam preview hold), so record-time start is prompt-free and
  // instant instead of firing getUserMedia (and losing the recording's
  // opening words) at the Record click.
  // ============================================================
  await scenario('BS toggle-ON drives acquireMicHold end-to-end: exactly one getUserMedia call, and the granted tracks are never stopped', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false };

    let stopped = false;
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', readyState: 'live', stop() { stopped = true; } }]);
    };

    sandbox.toggleSource('mic');
    await drain();

    assert(state.sources.mic === true, 'toggle turned on');
    assert(getUserMediaCalls.length === 1, 'exactly one getUserMedia call from the toggle click (got ' + getUserMediaCalls.length + ')');
    assert(state.heldMicStream !== null, 'the grant is held');
    assert(!stopped, 'the held tracks are never stopped just from acquiring — no prime-then-stop anymore');
  });

  await scenario('BT captureMic reuses a live, matching hold with zero additional getUserMedia calls, returning the exact held stream object', async () => {
    state.sources.mic = true;
    const track = { kind: 'audio', readyState: 'live', stop() {} };
    const held = makeStream([track]);
    state.heldMicStream = held;
    state.heldMicDeviceId = state.selectedMic; // '' — matches the default selection

    const stream = await sandbox.captureMic();

    assert(getUserMediaCalls.length === 0, 'no getUserMedia call — the hold is reused (got ' + getUserMediaCalls.length + ')');
    assert(stream === held, 'the exact held stream object is returned');
  });

  await scenario('BU captureMic falls back to a fresh acquire when the held track is dead (e.g. a Bluetooth mic dropout), without disturbing the stale hold itself', async () => {
    state.sources.mic = true;
    const deadTrack = { kind: 'audio', readyState: 'ended', stop() {} };
    state.heldMicStream = makeStream([deadTrack]);
    state.heldMicDeviceId = state.selectedMic;

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', readyState: 'live', stop() {} }]);
    };

    const stream = await sandbox.captureMic();

    assert(getUserMediaCalls.length === 1, 'a dead held track forces a fresh getUserMedia call (got ' + getUserMediaCalls.length + ')');
    assert(stream !== state.heldMicStream, 'the fresh stream is returned, not the dead hold');
    assert(state.heldMicStream && state.heldMicStream.getAudioTracks()[0] === deadTrack, 'captureMic itself does not touch/replace the stale hold — promoting a fresh stream into the hold is releaseMicRecordingRef\'s job at recording stop, not captureMic\'s');
  });

  await scenario('BV changing the mic dropdown selection while the toggle is on stops the old hold and re-acquires under the new deviceId constraint', async () => {
    mockDevices = [
      { kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' },
      { kind: 'audioinput', deviceId: 'mic2', label: 'Headset Mic' },
    ];
    await sandbox.enumerateDevices();
    await drain();
    state.sources.mic = true;
    state.selectedMic = 'mic1';

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return makeStream([{ kind: 'audio', readyState: 'live', stop() {} }]);
    };
    await sandbox.acquireMicHold(); // establishes the initial hold under mic1
    const oldHeld = state.heldMicStream;
    let oldStopped = false;
    oldHeld.getAudioTracks()[0].stop = () => { oldStopped = true; };
    assert(getUserMediaCalls.length === 1, 'sanity: initial hold acquired (got ' + getUserMediaCalls.length + ')');

    // Simulate picking a different device from the dropdown (onchange="onDeviceSelected('mic')" in the HTML).
    documentMock.getElementById('micSelect').value = 'mic2';
    sandbox.onDeviceSelected('mic');
    await drain();

    assert(state.selectedMic === 'mic2', 'state.selectedMic updated from the dropdown');
    assert(oldStopped, 'the old hold\'s tracks are stopped before re-acquiring');
    assert(getUserMediaCalls.length === 2, 'a second getUserMedia call re-acquires under the new device (got ' + getUserMediaCalls.length + ')');
    assert(getUserMediaCalls[1].audio && getUserMediaCalls[1].audio.deviceId && getUserMediaCalls[1].audio.deviceId.exact === 'mic2', 'the new hold requests the newly-selected deviceId (got: ' + JSON.stringify(getUserMediaCalls[1].audio) + ')');
    assert(state.heldMicStream !== oldHeld, 'a new stream object is now held');
    assert(state.heldMicDeviceId === 'mic2', 'heldMicDeviceId tracks the new selection');
  });

  await scenario('BW toggling mic off stops the held tracks and clears the hold state', async () => {
    state.sources.mic = true;
    let stopped = false;
    const track = { kind: 'audio', readyState: 'live', stop() { stopped = true; } };
    state.heldMicStream = makeStream([track]);
    state.heldMicDeviceId = state.selectedMic;

    sandbox.toggleSource('mic'); // was on -> toggles off

    assert(state.sources.mic === false, 'toggle turned off');
    assert(stopped, 'the held stream\'s tracks are stopped on toggle-OFF');
    assert(state.heldMicStream === null, 'heldMicStream cleared');
    assert(state.heldMicDeviceId === null, 'heldMicDeviceId cleared');
    assert(getUserMediaCalls.length === 0, 'toggling off makes no getUserMedia call');
  });

  await scenario('BX recording stop (cleanupStreams) preserves the hold while the toggle is on; the next captureMic call still makes zero getUserMedia calls', async () => {
    state.sources.mic = true;
    const track = { kind: 'audio', readyState: 'live', stop() {} };
    const held = makeStream([track]);
    state.heldMicStream = held;
    state.heldMicDeviceId = state.selectedMic;
    state.micStream = held; // captureMic returned the SAME object during the recording that just ended

    let stopped = false;
    track.stop = () => { stopped = true; };

    sandbox.cleanupStreams();

    assert(!stopped, 'the held stream\'s tracks are NOT stopped by a recording-stop cleanup while the toggle is on');
    assert(state.heldMicStream === held, 'the hold survives recording stop');
    assert(state.micStream === null, 'the recording-time reference is cleared');

    getUserMediaCalls = [];
    const reused = await sandbox.captureMic();
    assert(getUserMediaCalls.length === 0, 'the NEXT captureMic call reuses the surviving hold with zero getUserMedia calls (got ' + getUserMediaCalls.length + ')');
    assert(reused === held, 'captureMic returns the exact held stream object');
  });

  await scenario('BY recording stop promotes a fallback recording stream into the new hold when the toggle is on, retiring the stale dead hold', async () => {
    state.sources.mic = true;
    const deadTrack = { kind: 'audio', readyState: 'ended', stop() {} };
    const deadHeld = makeStream([deadTrack]);
    state.heldMicStream = deadHeld;
    state.heldMicDeviceId = state.selectedMic;
    let deadStopped = false;
    deadTrack.stop = () => { deadStopped = true; };

    // captureMic had to fall back mid-recording because the held track was dead
    // (see BU) — that fresh grant is state.micStream now, a DIFFERENT object
    // from state.heldMicStream.
    const freshTrack = { kind: 'audio', readyState: 'live', stop() {} };
    const fresh = makeStream([freshTrack]);
    state.micStream = fresh;
    let freshStopped = false;
    freshTrack.stop = () => { freshStopped = true; };

    sandbox.cleanupStreams();

    assert(deadStopped, 'the stale dead hold is stopped once a fresh stream replaces it');
    assert(!freshStopped, 'the fresh recording stream is NOT stopped — it becomes the new hold');
    assert(state.heldMicStream === fresh, 'the fresh stream is promoted into heldMicStream');
    assert(state.heldMicDeviceId === state.selectedMic, 'heldMicDeviceId is updated to the current selection');
    assert(state.micStream === null, 'the recording-time reference is cleared');
  });

  await scenario('BZ recording stop still stops mic tracks the old way when the toggle is off (releaseMicRecordingRef\'s toggle-off branch)', async () => {
    state.sources.mic = false;
    let stopped = false;
    const track = { kind: 'audio', stop() { stopped = true; } };
    state.micStream = makeStream([track]);

    sandbox.cleanupStreams();

    assert(stopped, 'mic tracks are still stopped on cleanup when the toggle is off');
    assert(state.micStream === null, 'recording-time reference cleared');
  });

  await scenario('CA a denied toggle-ON grant (via a real toggle click) reverts the toggle to off and shows a friendly message', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false };

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e;
    };

    sandbox.toggleSource('mic');
    await drain();

    assert(state.sources.mic === false, 'toggle reverted to off after the denial');
    assert(documentMock.getElementById('toggleMic').classList.contains('active') === false, 'toggle button UI reflects the revert, not left showing active with no hold behind it');
    assert(recordedErrors.some(m => /declined|denied/i.test(m)), 'a friendly error explains the denial (got: ' + JSON.stringify(recordedErrors) + ')');
    assert(state.heldMicStream === null, 'no hold exists after a denied grant');
  });

  await scenario('CB toggling off while a toggle-ON grant is still pending stops the late stream instead of holding it (race safety)', async () => {
    state.sources = { screen: true, camera: false, mic: false };

    let resolveGUM;
    const gumPromise = new Promise((res) => { resolveGUM = res; });
    let stopped = false;
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      return gumPromise;
    };

    sandbox.toggleSource('mic'); // toggle ON — kicks off acquireMicHold, still pending
    assert(state.sources.mic === true, 'toggle is on while the grant is pending');

    sandbox.toggleSource('mic'); // toggle OFF again before the grant resolves — stopMicHold no-ops (nothing held yet)
    assert(state.sources.mic === false, 'toggle is off again');

    resolveGUM(makeStream([{ kind: 'audio', readyState: 'live', stop() { stopped = true; } }]));
    await drain();

    assert(stopped, 'the late-arriving grant is stopped immediately instead of held, since the toggle is off by the time it resolves');
    assert(state.heldMicStream === null, 'no hold was left behind by the late grant');
  });

  await scenario('CC a selection change while the toggle-ON grant is pending books the hold under the acquisition-time device, so captureMic falls back instead of reusing the wrong mic', async () => {
    mockDevices = [
      { kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' },
      { kind: 'audioinput', deviceId: 'mic2', label: 'Headset Mic' },
    ];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false };
    state.selectedMic = 'mic1';
    documentMock.getElementById('micSelect').value = 'mic1';

    let resolveGUM;
    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      if (getUserMediaCalls.length === 1) return new Promise((res) => { resolveGUM = res; });
      return makeStream([{ kind: 'audio', readyState: 'live', stop() {} }]);
    };

    sandbox.toggleSource('mic'); // toggle ON — the mic1 grant is still pending
    // The user changes the dropdown while the prompt is still up. The
    // re-acquire in onDeviceSelected is swallowed by the in-flight guard,
    // so the grant that eventually resolves is still the mic1 one.
    documentMock.getElementById('micSelect').value = 'mic2';
    sandbox.onDeviceSelected('mic');
    resolveGUM(makeStream([{ kind: 'audio', readyState: 'live', stop() {} }]));
    await drain();

    assert(state.heldMicDeviceId === 'mic1', 'the hold is booked under the device it was actually acquired for, not the drifted selection (got: ' + state.heldMicDeviceId + ')');

    const before = getUserMediaCalls.length;
    await sandbox.captureMic();
    assert(getUserMediaCalls.length === before + 1, 'captureMic falls back to a fresh acquire instead of reusing the mic1 hold (calls went ' + before + ' -> ' + getUserMediaCalls.length + ')');
    assert(getUserMediaCalls[before].audio.deviceId && getUserMediaCalls[before].audio.deviceId.exact === 'mic2', 'the fallback requests the currently-selected device (got: ' + JSON.stringify(getUserMediaCalls[before].audio) + ')');
  });

  await scenario('CD a device failure at toggle-ON (not a denial) reverts the toggle with a message about the device, not about permission', async () => {
    mockDevices = [];
    await sandbox.enumerateDevices();
    await drain();
    state.sources = { screen: true, camera: false, mic: false };

    sandbox.navigator.mediaDevices.getUserMedia = async (c) => {
      getUserMediaCalls.push(c);
      const e = new Error('Could not start audio source'); e.name = 'NotReadableError'; throw e;
    };

    sandbox.toggleSource('mic');
    await drain();

    assert(state.sources.mic === false, 'toggle reverted to off after the device failure');
    assert(state.heldMicStream === null, 'no hold exists after the failure');
    assert(recordedErrors.some(m => /connected|in use by another app/i.test(m)), 'the message points at the device, not permission (got: ' + JSON.stringify(recordedErrors) + ')');
    assert(!recordedErrors.some(m => /declined/i.test(m)), 'the denial copy is not shown for a non-denial failure');
  });

  // ==================== Caption logic (v1.17) ====================
  // Pure parsing/formatting/serialization for the caption-editor foundation.
  // No DOM, no state — these all go through `api.*` directly, no resetState
  // dependency at all, but the harness still calls it for consistency.

  await scenario('CE parseCaptionTimestamp/formatCaptionTimestamp round-trip and edge cases', async () => {
    assert(api.parseCaptionTimestamp('00:00:00.000') === 0, 'zero parses to 0');
    assert(Math.abs(api.parseCaptionTimestamp('01:02:03.456') - (3600 + 120 + 3 + 0.456)) < 1e-9, '>1h timestamp parses correctly');
    assert(Math.abs(api.parseCaptionTimestamp('123:45:12.345') - (123 * 3600 + 45 * 60 + 12 + 0.345)) < 1e-9, '3-digit hours parse (large VTT hour counts)');
    assert(api.parseCaptionTimestamp('1:02:03,456') === 3723.456, 'unpadded single-digit hour (hand-authored SRT) parses, not just 2+ digit hours');
    assert(api.parseCaptionTimestamp('00:00:01,500') === 1.5, 'comma decimal separator tolerated (SRT style)');
    assert(api.parseCaptionTimestamp('01:02.500') === 62.5, 'MM:SS.mmm hours-optional VTT form parses');
    assert(api.parseCaptionTimestamp('not a timestamp') === null, 'garbage returns null instead of throwing');
    assert(api.parseCaptionTimestamp('12:99:00.000') === null, 'out-of-range minutes rejected');
    assert(api.parseCaptionTimestamp('') === null, 'empty string returns null');
    assert(api.parseCaptionTimestamp(null) === null, 'non-string input returns null, never throws');

    assert(api.formatCaptionTimestamp(0) === '00:00:00.000', 'zero formats with dot separator by default');
    assert(api.formatCaptionTimestamp(3723.456) === '01:02:03.456', '>1h formats correctly');
    assert(api.formatCaptionTimestamp(360000) === '100:00:00.000', '>=100h emits extra hour digits instead of truncating');
    assert(api.formatCaptionTimestamp(1.9995) === '00:00:02.000', 'ms rounding carries into seconds (never 00:00:01.1000)');
    assert(api.formatCaptionTimestamp(-5) === '00:00:00.000', 'negative seconds clamp to 0');
    assert(api.formatCaptionTimestamp(5, ',') === '00:00:05,000', 'comma separator produces SRT-style output');
    assert(api.formatCaptionTimestamp(1.5, ',') === '00:00:01,500', 'comma separator with fractional seconds');
  });

  const CF_VTT = `WEBVTT

NOTE
This is a note before styles

STYLE
::cue { color: yellow; }

1
00:00:01.000 --> 00:00:04.000 align:start line:0
<v Roger>Hello world

cue-2
00:00:05.500 --> 00:00:07.250
Second <i>line</i> of text
with a wrapped second row
`;

  await scenario('CF VTT round-trip preserves prologue (NOTE+STYLE), cue ids, and settings verbatim', async () => {
    const parsed = api.parseVTT(CF_VTT);
    assert(parsed.skipped === 0, 'no cues skipped (got ' + parsed.skipped + ')');
    assert(parsed.cues.length === 2, 'both cues parsed (got ' + parsed.cues.length + ')');
    assert(parsed.cues[0].id === '1', 'first cue id preserved (got ' + JSON.stringify(parsed.cues[0].id) + ')');
    assert(parsed.cues[0].settings === 'align:start line:0', 'cue-settings tail preserved verbatim (got ' + JSON.stringify(parsed.cues[0].settings) + ')');
    assert(parsed.cues[0].text === '<v Roger>Hello world', 'voice span passed through untouched');
    assert(Math.abs(parsed.cues[0].start - 1) < 1e-9 && Math.abs(parsed.cues[0].end - 4) < 1e-9, 'first cue timings parsed');
    assert(parsed.cues[1].id === 'cue-2', 'second cue id preserved');
    assert(parsed.cues[1].settings === '', 'second cue has no settings tail');
    assert(parsed.cues[1].text === 'Second <i>line</i> of text\nwith a wrapped second row', 'multi-line cue text joined with \\n, no stray trailing blank line (got ' + JSON.stringify(parsed.cues[1].text) + ')');
    assert(parsed.prologue.indexOf('NOTE') !== -1 && parsed.prologue.indexOf('STYLE') !== -1 && parsed.prologue.indexOf('::cue { color: yellow; }') !== -1, 'prologue captures NOTE and STYLE blocks verbatim (got ' + JSON.stringify(parsed.prologue) + ')');

    const serialized = api.serializeVTT(parsed);
    assert(serialized.indexOf('WEBVTT\n\n') === 0, 'serialized output opens with the WEBVTT header');
    assert(!/\n\n\n/.test(serialized), 'no triple-newline artifacts between blocks');
    assert(!serialized.endsWith('\n\n'), 'exactly one trailing newline');

    const reparsed = api.parseVTT(serialized);
    assert(reparsed.skipped === 0, 'round-trip: no cues skipped on reparse');
    assert(reparsed.cues.length === 2, 'round-trip: both cues survive');
    assert(reparsed.prologue === parsed.prologue, 'round-trip: prologue is byte-identical');
    assert(reparsed.cues[0].id === '1' && reparsed.cues[0].settings === 'align:start line:0', 'round-trip: id and settings survive');
    assert(reparsed.cues[1].text === parsed.cues[1].text, 'round-trip: multi-line text survives');
  });

  const CG_SRT = `5
00:00:01,000 --> 00:00:02,500
Hello there

9
00:00:03,000 --> 00:00:04,000
Second line
`;

  await scenario('CG SRT round-trip renumbers sequentially from 1, ignoring the original index values', async () => {
    const parsed = api.parseSRT(CG_SRT);
    assert(parsed.skipped === 0, 'both cues parsed');
    assert(parsed.cues.length === 2, 'two cues');
    assert(parsed.cues[0].id === null && parsed.cues[1].id === null, 'SRT index is not kept as cue.id');
    assert(parsed.prologue === '', 'SRT has no prologue concept');
    assert(Math.abs(parsed.cues[0].start - 1) < 1e-9 && Math.abs(parsed.cues[0].end - 2.5) < 1e-9, 'first cue timing (comma decimals) parsed');
    assert(parsed.cues[0].text === 'Hello there', 'first cue text');
    assert(parsed.cues[1].text === 'Second line', 'second cue text, no stray trailing blank line (got ' + JSON.stringify(parsed.cues[1].text) + ')');

    const serialized = api.serializeSRT(parsed);
    assert(!serialized.endsWith('\n\n'), 'exactly one trailing newline');
    const blocks = serialized.replace(/\n+$/, '').split(/\n\n/);
    assert(blocks.length === 2, 'two SRT blocks serialized');
    assert(blocks[0].split('\n')[0] === '1', 'first block renumbered to 1 (original index was 5, got ' + blocks[0].split('\n')[0] + ')');
    assert(blocks[1].split('\n')[0] === '2', 'second block renumbered to 2 (original index was 9, got ' + blocks[1].split('\n')[0] + ')');
    assert(/00:00:01,000 --> 00:00:02,500/.test(blocks[0]), 'comma-decimal timing serialized');

    const reparsed = api.parseSRT(serialized);
    assert(reparsed.cues.length === 2 && reparsed.skipped === 0, 'round-trip: both cues survive');
    assert(reparsed.cues[0].text === parsed.cues[0].text && reparsed.cues[1].text === parsed.cues[1].text, 'round-trip: text unchanged');
    assert(reparsed.cues[0].id === null, 'round-trip: ids stay null (SRT never carries an id)');
  });

  const CH_SRT = `1
00:00:01,000 --> 00:00:03,000
Cross format <b>text</b>
`;

  await scenario('CH SRT parses then serializes as VTT (cross-format conversion)', async () => {
    const parsed = api.parseSRT(CH_SRT);
    assert(parsed.cues.length === 1 && parsed.skipped === 0, 'one cue parsed from SRT');
    const vtt = api.serializeVTT(parsed);
    assert(vtt.indexOf('WEBVTT') === 0, 'output starts with a WEBVTT header');
    assert(vtt.indexOf('00:00:01.000 --> 00:00:03.000') !== -1, 'timings converted to dot-decimal VTT style (got ' + vtt + ')');
    assert(vtt.indexOf('Cross format <b>text</b>') !== -1, 'text and tags carried through untouched');
    assert(vtt.indexOf(',') === -1, 'no comma decimals leak into VTT output');

    const reparsed = api.parseVTT(vtt);
    assert(reparsed.cues.length === 1 && reparsed.skipped === 0, 'converted VTT reparses cleanly');
    assert(Math.abs(reparsed.cues[0].start - 1) < 1e-9 && Math.abs(reparsed.cues[0].end - 3) < 1e-9, 'timings preserved across the conversion');
  });

  await scenario('CI strips a leading BOM and normalizes CRLF/CR line endings before parsing', async () => {
    const withBomCrlf = '\uFEFF' + 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n';
    const parsed = api.parseVTT(withBomCrlf);
    assert(parsed.skipped === 0, 'no skipped cues despite BOM+CRLF (got skipped=' + parsed.skipped + ')');
    assert(parsed.cues.length === 1, 'one cue parsed');
    assert(parsed.cues[0].text === 'Hello', 'text has no leftover \\r characters (got ' + JSON.stringify(parsed.cues[0].text) + ')');
    assert(Math.abs(parsed.cues[0].start - 1) < 1e-9 && Math.abs(parsed.cues[0].end - 2) < 1e-9, 'timings parsed correctly through CRLF');

    const bareCR = 'WEBVTT\r\r00:00:05.000 --> 00:00:06.000\rWorld\r';
    const parsed2 = api.parseVTT(bareCR);
    assert(parsed2.skipped === 0 && parsed2.cues.length === 1, 'lone CR (old Mac line endings) is also normalized');
    assert(parsed2.cues[0].text === 'World', 'text is clean after CR-only normalization (got ' + JSON.stringify(parsed2.cues[0].text) + ')');
  });

  await scenario('CJ a missing WEBVTT header still parses best-effort, and the missing header itself is never counted as skipped', async () => {
    const noHeader = `00:00:01.000 --> 00:00:02.000
No header here
`;
    const parsed = api.parseVTT(noHeader);
    assert(parsed.skipped === 0, 'missing header is not itself a skip (got ' + parsed.skipped + ')');
    assert(parsed.cues.length === 1, 'cue still parsed without a WEBVTT header');
    assert(parsed.cues[0].text === 'No header here', 'cue text intact');
  });

  await scenario('CK VTT tolerates hours-optional timestamps and comma decimals inside the same cue', async () => {
    const mixed = `WEBVTT

01:02.500 --> 01:05,750
Hours-optional and comma-decimal mixed
`;
    const parsed = api.parseVTT(mixed);
    assert(parsed.skipped === 0, 'no cues skipped (got ' + parsed.skipped + ')');
    assert(parsed.cues.length === 1, 'one cue parsed');
    assert(Math.abs(parsed.cues[0].start - 62.5) < 1e-9, 'hours-optional MM:SS.mmm start parses (got ' + parsed.cues[0].start + ')');
    assert(Math.abs(parsed.cues[0].end - 65.75) < 1e-9, 'comma-decimal end timestamp tolerated inside a VTT file (got ' + parsed.cues[0].end + ')');
  });

  const CL_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
Good cue one

2
00:00:05.000 -> 00:00:06.000
Wrong arrow, should be skipped

3
00:00:10.000 --> 00:00:09.000
End before start, should be skipped

Not a timing line at all, no arrow

00:00:20.000 --> 00:00:21.000

5
00:00:25.000 --> 00:00:26.000
Good cue two
`;

  await scenario('CL one mixed VTT file tolerates wrong-arrow, end-before-start, missing-timing-line, and empty-text cues while good cues still parse (modeled on prior-art invalid-sample.vtt)', async () => {
    const parsed = api.parseVTT(CL_VTT);
    assert(parsed.skipped === 4, 'exactly 4 malformed cue blocks skipped (got ' + parsed.skipped + ')');
    assert(parsed.cues.length === 2, 'the 2 well-formed cues still parse (got ' + parsed.cues.length + ')');
    assert(parsed.cues[0].id === '1' && parsed.cues[0].text === 'Good cue one', 'first good cue intact');
    assert(parsed.cues[1].id === '5' && parsed.cues[1].text === 'Good cue two', 'second good cue intact — parsing continued past every malformed block');
  });

  await scenario('CM detectCaptionFormat sniffs content first, falls back to the filename extension, and defaults to vtt', async () => {
    assert(api.detectCaptionFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 'whatever.srt') === 'vtt', 'a WEBVTT header wins over a misleading .srt filename');
    assert(api.detectCaptionFormat('1\n00:00:01,000 --> 00:00:02,000\nHi\n', 'whatever.vtt') === 'srt', 'SRT-shaped content wins over a misleading .vtt filename');
    assert(api.detectCaptionFormat('garbage text with no clear shape', 'captions.srt') === 'srt', 'falls back to the filename extension when content sniffing is inconclusive');
    assert(api.detectCaptionFormat('garbage text with no clear shape', 'captions.vtt') === 'vtt', 'filename fallback also recognizes .vtt');
    assert(api.detectCaptionFormat('garbage text with no clear shape', 'captions.txt') === 'vtt', 'an unrecognized extension defaults to vtt');
    assert(api.detectCaptionFormat('garbage text with no clear shape', undefined) === 'vtt', 'no filename at all defaults to vtt');
    assert(api.detectCaptionFormat('', '') === 'vtt', 'empty inputs default to vtt without throwing');
  });

  await scenario('CN tags and voice-spans pass through parse, serialize, and reparse untouched in both formats', async () => {
    const expectedText = "<v Prof. Lee>Welcome, <i>everyone</i>. Let's begin — 50% > 25%.";
    const taggedVTT = `WEBVTT

00:00:01.000 --> 00:00:02.000
${expectedText}
`;
    const parsed = api.parseVTT(taggedVTT);
    assert(parsed.cues.length === 1 && parsed.skipped === 0, 'cue parsed');
    assert(parsed.cues[0].text === expectedText, 'tags/voice-span text is byte-identical after parsing (got ' + JSON.stringify(parsed.cues[0].text) + ')');

    const serialized = api.serializeVTT(parsed);
    const reparsed = api.parseVTT(serialized);
    assert(reparsed.cues[0].text === expectedText, 'tags/voice-span text survives a full VTT round-trip');

    // SRT has no tag semantics of its own — the same text passes through as opaque content.
    const srtOut = api.serializeSRT(parsed);
    const srtParsed = api.parseSRT(srtOut);
    assert(srtParsed.cues[0].text === expectedText, 'tags/voice-span text survives serialization to SRT and back');
  });

  await scenario('CO a multi-line WEBVTT header block (YouTube-style Kind:/Language: metadata) is dropped whole, not mis-parsed as a cue', async () => {
    const withMetaHeader = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:02.000
Real cue text
`;
    const parsed = api.parseVTT(withMetaHeader);
    assert(parsed.skipped === 0, 'the multi-line header block is not counted as a skipped cue (got skipped=' + parsed.skipped + ')');
    assert(parsed.cues.length === 1, 'exactly the one real cue parses (got ' + parsed.cues.length + ')');
    assert(parsed.cues[0].text === 'Real cue text', 'cue text is untouched by the header metadata');
    assert(parsed.prologue === '', 'the header itself is not captured as prologue (only NOTE/STYLE/REGION are)');
  });

  await scenario('CP whitespace-only separator lines (a stray space/tab on an otherwise-blank line) still split blocks in both SRT and VTT', async () => {
    const srtWithBlankishSeparator = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n \n2\n00:00:03,000 --> 00:00:04,000\nSecond\n';
    const srtParsed = api.parseSRT(srtWithBlankishSeparator);
    assert(srtParsed.skipped === 0, 'no cues skipped across the whitespace-only separator (got skipped=' + srtParsed.skipped + ')');
    assert(srtParsed.cues.length === 2, 'both SRT cues parse despite the "\\n \\n" separator (got ' + srtParsed.cues.length + ')');
    assert(srtParsed.cues[0].text === 'First' && srtParsed.cues[1].text === 'Second', 'cue text on each side of the blank-ish line is correct');

    const vttWithBlankishSeparator = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst\n\t\n00:00:03.000 --> 00:00:04.000\nSecond\n';
    const vttParsed = api.parseVTT(vttWithBlankishSeparator);
    assert(vttParsed.skipped === 0, 'no VTT cues skipped across a tab-only separator line (got skipped=' + vttParsed.skipped + ')');
    assert(vttParsed.cues.length === 2, 'both VTT cues parse despite the "\\n\\t\\n" separator (got ' + vttParsed.cues.length + ')');
  });

  console.log('\n================  ' + passed + ' passed, ' + failed + ' failed  ================');
  process.exit(failed ? 1 : 0);
})();
