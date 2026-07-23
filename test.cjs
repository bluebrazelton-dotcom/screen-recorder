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
  return {
    id, style: {}, _cls: cls,
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : f; on ? cls.add(c) : cls.delete(c); },
      contains: (c) => cls.has(c),
    },
    set textContent(v) { this._t = v; }, get textContent() { return this._t || ''; },
    set className(v) { this._cn = v; }, get className() { return this._cn || ''; },
    set disabled(v) { this._d = v; }, get disabled() { return this._d; },
    set value(v) { this._v = v; }, get value() { return this._v || ''; },
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; },
    set srcObject(v) { this._s = v; }, get srcObject() { return this._s; },
    appendChild() {}, removeChild() {}, click() {},
    querySelector() { return null; },
    addEventListener() {}, removeEventListener() {},
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
  navigator: { mediaDevices: { addEventListener() {}, getUserMedia: async () => makeStream([]), getDisplayMedia: async () => makeStream([{ kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {}, stop() {} }]), enumerateDevices: async () => [] } },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
code += '\n;globalThis.__api = { state, pipState, createSession, addChunk, getSessionChunks, deleteSession, finalizeRecording, stitchAndSave, recoverRecording, startRecording, startCompositing, stopCompositing, startDrawClock };';
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app_new.js' });
const api = sandbox.__api;
const state = api.state;
const ORIG = { addChunk: sandbox.addChunk, concatenateWebM: sandbox.concatenateWebM };
sandbox.showError = (m) => { recordedErrors.push(m || ''); };
const ORIG_updateStatus = sandbox.updateStatus;
sandbox.updateStatus = (mode, text) => { statusHistory.push(text); return ORIG_updateStatus(mode, text); };
const ORIG_CARRY_CAP = sandbox.STREAM_CARRY_CAP;

// ---------- helpers ----------
function flushRaf() { const q = rafQueue; rafQueue = []; for (const { cb } of q) cb(16); }
const drain = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function resetDB() { return new Promise((res) => { const r = gidb.deleteDatabase('screen-recorder-db'); r.onsuccess = r.onerror = r.onblocked = () => res(); }); }
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
  Object.assign(state, { sessionId: null, chunkIndex: 0, recording: false, paused: false, mediaRecorder: null, screenStream: null, cameraStream: null, micStream: null, audioContext: null, compositeStream: null, drawFrame: null, drawWorker: null, drawWorkerUrl: null, animFrameId: null, priorSegments: [] });
  windowMock._recoverySessions = null; windowMock._recoverySessionId = null; windowMock._recoveryMimeType = null;
  delete windowMock.showSaveFilePicker;   // absent = Firefox mode; FSA scenarios set their own picker
  sandbox.addChunk = ORIG.addChunk; sandbox.concatenateWebM = ORIG.concatenateWebM;
  sandbox.downloadPendingIds = [];
  documentMock.getElementById('downloadConfirm').classList.remove('visible');
  documentMock.getElementById('recoveryBanner').classList.remove('visible');
  documentMock.hidden = false;
  lastWritten = []; recordedErrors = []; rafQueue = []; addChunkCalls = 0; downloadClicks = [];
  writeCalls = []; abortCalls = 0; closedFiles = 0; failWriteAfter = -1;
  statusHistory = []; objectUrlBlobs = [];
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
  await scenario('D stitch success deletes all segments', async () => {
    const p1 = await seed(2), p2 = await seed(2), cur = await seed(2);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }, { sessionId: p2, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 2;
    windowMock.showSaveFilePicker = pickerSequence(['ok']);
    await api.finalizeRecording();
    await drain();
    const sessions = await readStore('sessions');
    assert(sessions.length === 0, 'all sessions deleted after stitch save (got ' + sessions.length + ')');
    assert(state.priorSegments.length === 0, 'priorSegments cleared');
    assert(lastWritten.length === 1, 'one stitched file written');
  });

  // E — recovery, stitch FAILS, cancel on 2nd part -> only written part deleted
  await scenario('E recovery stitch-fail saves parts, deletes only written', async () => {
    const s1 = await seed(2), s2 = await seed(2), s3 = await seed(2);
    windowMock._recoverySessions = [{ id: s1, mimeType: 'video/webm' }, { id: s2, mimeType: 'video/webm' }, { id: s3, mimeType: 'video/webm' }];
    sandbox.concatenateWebM = async () => { throw new Error('forced stitch fail'); };
    windowMock.showSaveFilePicker = pickerSequence(['ok', 'abort']); // part1 saves, part2 cancels
    await api.recoverRecording();
    await drain();
    const sessions = await readStore('sessions');
    const ids = sessions.map(s => s.id);
    assert(!ids.includes(s1), 's1 deleted (was written)');
    assert(ids.includes(s2) && ids.includes(s3), 's2 & s3 preserved (not written)');
    assert(lastWritten.length === 1, 'exactly one part written before cancel (got ' + lastWritten.length + ')');
    assert(recordedErrors.some(m => /separate file/i.test(m)), 'told parts saved separately');
  });

  // E2 — recovery, stitch FAILS, all parts save -> all deleted
  await scenario('E2 recovery stitch-fail all-save deletes all', async () => {
    await seed(2); await seed(2); // ids captured via recovery list below
    const all = await readStore('sessions');
    windowMock._recoverySessions = all.map(s => ({ id: s.id, mimeType: 'video/webm' }));
    sandbox.concatenateWebM = async () => { throw new Error('forced stitch fail'); };
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
  await scenario('S firefox stitched download keeps all segments until confirmed', async () => {
    const p1 = await seed(2), p2 = await seed(2), cur = await seed(2);
    state.priorSegments = [{ sessionId: p1, mimeType: 'video/webm' }, { sessionId: p2, mimeType: 'video/webm' }];
    state.sessionId = cur; state.chunkIndex = 2;
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

  // T — recovery stitch-fail: every part downloads, all kept until confirmed
  await scenario('T firefox recovery stitch-fail keeps all parts until confirmed', async () => {
    const s1 = await seed(2), s2 = await seed(2);
    sandbox.concatenateWebM = async () => { throw new Error('forced stitch fail'); };
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

  async function seedBuffers(parts, indexes) {
    const id = await api.createSession('video/webm;codecs=vp9,opus');
    for (let i = 0; i < parts.length; i++) await api.addChunk(id, indexes ? indexes[i] : i, new Blob([parts[i]]));
    return id;
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

  console.log('\n================  ' + passed + ' passed, ' + failed + ' failed  ================');
  process.exit(failed ? 1 : 0);
})();
