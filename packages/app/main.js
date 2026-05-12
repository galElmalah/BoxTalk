const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { VibeVoiceBackend } = require("./vibevoice");
const { KokoroClient } = require("./kokoroClient");

// Pin the userData path so it never depends on package.json (`name`,
// scope, etc.). Without this, renaming the npm package moves
// ~/Library/Application Support/<name>/ and the user loses history, the
// bridge token, and any downloaded models.
//
// Must run before `app.getPath('userData')` is called anywhere.
app.setName("BoxTalk");

// Migrate data from any older userData directory the app used to use. We
// move on a per-asset basis (DB, vibevoice cache, digests) so a partially-
// populated BoxTalk/ dir from an earlier launch doesn't block recovery of
// data that lives in an older location.
(function migrateUserData() {
  try {
    const target = app.getPath("userData"); // ~/Library/Application Support/BoxTalk
    fs.mkdirSync(target, { recursive: true });
    const parent = path.dirname(target);
    const olderDirs = ["@boxtalk/app", "@boxtalk", "tts-electron"];
    const assets = ["boxtalk.db", "boxtalk.db-shm", "boxtalk.db-wal", "vibevoice", "digests"];
    for (const dir of olderDirs) {
      for (const asset of assets) {
        const src = path.join(parent, dir, asset);
        const dst = path.join(target, asset);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.renameSync(src, dst);
          console.log(`[migrate] ${src} → ${dst}`);
        }
      }
    }
  } catch (err) {
    console.error("[migrate] userData migration failed:", err);
  }
})();

// Surface unhandled errors instead of dying silently. Without these handlers
// an unhandled rejection or stray throw kills the Electron main process with
// no stack trace, which is what was happening on long digest runs.
process.on("uncaughtException", (err) => {
  console.error("[main:uncaughtException]", err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main:unhandledRejection]", reason?.stack || reason);
});

const DEFAULT_MAX_HISTORY = 20;
const MAX_HISTORY_LIMIT = 1000;
const BRIDGE_PORT = 38219;
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_MAX_BODY = 5 * 1024 * 1024;

// Model registry. UI metadata (scores, run modes, voices) lives in the renderer;
// here we just need backend dispatch info.
const MODELS = {
  kokoro: {
    backend: "kokoro",
    hfId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    autoLoad: true,
  },
  "vibevoice-realtime": {
    backend: "vibevoice",
    hfId: "microsoft/VibeVoice-Realtime-0.5B",
  },
  "vibevoice-1.5b": {
    backend: "vibevoice",
    hfId: "microsoft/VibeVoice-1.5B",
  },
  "vibevoice-large": {
    backend: "vibevoice",
    hfId: "microsoft/VibeVoice-Large",
  },
};

let mainWindow = null;
let db = null;
let stmts = null;

const modelStates = Object.fromEntries(
  Object.keys(MODELS).map((id) => [id, { state: "idle", error: null }]),
);

const engines = {
  kokoro: null,
  vibevoice: null,
};

// ──────────────── Database ────────────────────────────────────────────

function openDatabase() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "boxtalk.db");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      voice         TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'Manual',
      timestamp     INTEGER NOT NULL,
      duration_sec  REAL,
      size          INTEGER,
      sampling_rate INTEGER,
      synth_ms      INTEGER
    );
    CREATE INDEX IF NOT EXISTS history_ts ON history(timestamp DESC);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'Extension',
      source_url    TEXT,
      title         TEXT,
      timestamp     INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      voice         TEXT,
      audio_path    TEXT,
      duration_sec  REAL,
      size          INTEGER,
      sampling_rate INTEGER,
      synth_ms      INTEGER,
      digested_at   INTEGER,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS candidates_ts ON candidates(timestamp DESC);
    CREATE INDEX IF NOT EXISTS candidates_status ON candidates(status);
  `);

  // Migrate older DBs that pre-date the digestion columns.
  const candidateCols = new Set(db.prepare("PRAGMA table_info(candidates)").all().map(r => r.name));
  const adds = [
    ["status",        "TEXT NOT NULL DEFAULT 'pending'"],
    ["voice",         "TEXT"],
    ["audio_path",    "TEXT"],
    ["duration_sec",  "REAL"],
    ["size",          "INTEGER"],
    ["sampling_rate", "INTEGER"],
    ["synth_ms",      "INTEGER"],
    ["digested_at",   "INTEGER"],
    ["error",         "TEXT"],
  ];
  for (const [col, decl] of adds) {
    if (!candidateCols.has(col)) {
      db.exec(`ALTER TABLE candidates ADD COLUMN ${col} ${decl}`);
    }
  }

  stmts = {
    listHistory: db.prepare(
      `SELECT id, text, voice, source, timestamp,
              duration_sec   AS durationSec,
              size,
              sampling_rate  AS samplingRate,
              synth_ms       AS synthMs
       FROM history
       ORDER BY timestamp DESC`,
    ),
    addHistory: db.prepare(
      `INSERT OR REPLACE INTO history
       (id, text, voice, source, timestamp, duration_sec, size, sampling_rate, synth_ms)
       VALUES (@id, @text, @voice, @source, @timestamp, @durationSec, @size, @samplingRate, @synthMs)`,
    ),
    clearHistory: db.prepare(`DELETE FROM history`),
    capHistory: db.prepare(
      `DELETE FROM history
       WHERE id NOT IN (SELECT id FROM history ORDER BY timestamp DESC LIMIT ?)`,
    ),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),
    listCandidates: db.prepare(
      `SELECT id, text, source, source_url AS sourceUrl, title, timestamp,
              status, voice, audio_path AS audioPath,
              duration_sec  AS durationSec,
              size,
              sampling_rate AS samplingRate,
              synth_ms      AS synthMs,
              digested_at   AS digestedAt,
              error
       FROM candidates
       ORDER BY timestamp DESC`,
    ),
    getCandidate: db.prepare(
      `SELECT id, text, source, source_url AS sourceUrl, title, timestamp,
              status, voice, audio_path AS audioPath,
              duration_sec  AS durationSec,
              size,
              sampling_rate AS samplingRate,
              synth_ms      AS synthMs,
              digested_at   AS digestedAt,
              error
       FROM candidates WHERE id = ?`,
    ),
    addCandidate: db.prepare(
      `INSERT INTO candidates (id, text, source, source_url, title, timestamp, status)
       VALUES (@id, @text, @source, @sourceUrl, @title, @timestamp, 'pending')`,
    ),
    setCandidateStatus: db.prepare(
      `UPDATE candidates SET status = @status, error = @error WHERE id = @id`,
    ),
    setCandidateDigested: db.prepare(
      `UPDATE candidates
       SET status = 'digested',
           voice = @voice,
           audio_path = @audioPath,
           duration_sec = @durationSec,
           size = @size,
           sampling_rate = @samplingRate,
           synth_ms = @synthMs,
           digested_at = @digestedAt,
           error = NULL
       WHERE id = @id`,
    ),
    deleteCandidate: db.prepare(`DELETE FROM candidates WHERE id = ?`),
    clearCandidates: db.prepare(`DELETE FROM candidates`),
    countCandidates: db.prepare(`SELECT COUNT(*) AS n FROM candidates`),
  };
}

function getSetting(key, fallback) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : fallback;
}

function getMaxHistory() {
  const n = parseInt(getSetting("maxHistory", String(DEFAULT_MAX_HISTORY)), 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_HISTORY_LIMIT ? n : DEFAULT_MAX_HISTORY;
}

function getOrCreateBridgeToken() {
  let token = getSetting("bridgeToken", null);
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    stmts.setSetting.run("bridgeToken", token);
  }
  return token;
}

// ──────────────── Model loading ────────────────────────────────────────

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function setModelState(id, state, error = null) {
  modelStates[id] = { state, error };
  broadcast("models:state", { modelId: id, state, error });
}

function emitModelProgress(id, progress) {
  broadcast("models:progress", { modelId: id, ...progress });
}

async function loadKokoro() {
  if (modelStates.kokoro.state === "loading" || modelStates.kokoro.state === "ready") return;
  setModelState("kokoro", "loading");
  const t0 = Date.now();
  try {
    if (!engines.kokoro) {
      engines.kokoro = new KokoroClient({
        onProgress: (data) => emitModelProgress("kokoro", data),
      });
    }
    // Cache the model under userData so a packaged .app (read-only asar)
    // still has somewhere writable to land the downloaded ONNX file.
    const cacheDir = path.join(app.getPath("userData"), "transformers-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    await engines.kokoro.load({ hfId: MODELS.kokoro.hfId, dtype: "q8", device: "cpu", cacheDir });
    console.log(`Kokoro loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    setModelState("kokoro", "ready");
  } catch (err) {
    console.error("Failed to load Kokoro:", err);
    setModelState("kokoro", "error", err?.message ?? String(err));
  }
}

async function loadVibeVoice(modelId) {
  const cfg = MODELS[modelId];
  if (!cfg) throw new Error("unknown model: " + modelId);
  if (modelStates[modelId].state === "loading" || modelStates[modelId].state === "ready") return;

  setModelState(modelId, "loading");
  try {
    if (!engines.vibevoice) {
      engines.vibevoice = new VibeVoiceBackend({
        userDataDir: app.getPath("userData"),
        onProgress: (mid, p) => emitModelProgress(mid, p),
      });
      await engines.vibevoice.start();
    }
    await engines.vibevoice.loadModel(modelId);
    setModelState(modelId, "ready");
  } catch (err) {
    console.error(`Failed to load ${modelId}:`, err);
    setModelState(modelId, "error", err?.message ?? String(err));
  }
}

// ──────────────── Generation ───────────────────────────────────────────

async function generateKokoro({ voice, text, speed }) {
  if (!engines.kokoro) throw new Error("kokoro not loaded");
  const { samples, samplingRate, synthMs } = await engines.kokoro.generate({ voice, text, speed });
  return {
    wav: encodeWav(samples, samplingRate),
    samplingRate,
    samples: samples.length,
    synthMs,
  };
}

async function generateVibeVoice({ modelId, voice, text, speed, mode }) {
  if (!engines.vibevoice) throw new Error("vibevoice sidecar not running");
  return engines.vibevoice.generate({ modelId, voice, text, speed, mode });
}

// ──────────────── IPC ─────────────────────────────────────────────────

ipcMain.handle("models:states", () => modelStates);

ipcMain.handle("models:load", async (_e, modelId) => {
  if (!MODELS[modelId]) throw new Error("unknown model: " + modelId);
  if (MODELS[modelId].backend === "kokoro") return loadKokoro();
  return loadVibeVoice(modelId);
});

ipcMain.handle("tts:generate", async (_e, { modelId = "kokoro", voice, text, speed, mode }) => {
  const cfg = MODELS[modelId];
  if (!cfg) throw new Error("unknown model: " + modelId);
  if (modelStates[modelId].state !== "ready") throw new Error(`${modelId} not loaded`);
  if (!text || typeof text !== "string") throw new Error("text required");
  if (!voice || typeof voice !== "string") throw new Error("voice required");
  if (cfg.backend === "kokoro") return generateKokoro({ voice, text, speed });
  return generateVibeVoice({ modelId, voice, text, speed, mode });
});

ipcMain.handle("store:listHistory", () => stmts.listHistory.all());

ipcMain.handle("store:addHistory", (_e, entry) => {
  const row = {
    id: entry.id,
    text: String(entry.text),
    voice: String(entry.voice),
    source: entry.source || "Manual",
    timestamp: entry.timestamp || Date.now(),
    durationSec: entry.durationSec ?? null,
    size: entry.size ?? null,
    samplingRate: entry.samplingRate ?? null,
    synthMs: entry.synthMs ?? null,
  };
  stmts.addHistory.run(row);
  stmts.capHistory.run(getMaxHistory());
  return row;
});

ipcMain.handle("store:clearHistory", () => stmts.clearHistory.run().changes);
ipcMain.handle("store:getMaxHistory", () => getMaxHistory());

ipcMain.handle("store:setMaxHistory", (_e, n) => {
  const clamped = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(Number(n)) || DEFAULT_MAX_HISTORY));
  stmts.setSetting.run("maxHistory", String(clamped));
  stmts.capHistory.run(clamped);
  return clamped;
});

ipcMain.handle("store:getSelectedVoice", () => getSetting("selectedVoice", null));

ipcMain.handle("store:setSelectedVoice", (_e, voice) => {
  stmts.setSetting.run("selectedVoice", String(voice));
  return voice;
});

// Generic settings backed by the `settings` table. Renderer is responsible
// for serializing complex values (JSON.stringify); values returned as-is.
const MAX_SETTING_BYTES = 256 * 1024; // 256KB cap per key
ipcMain.handle("store:getSetting", (_e, key) => getSetting(String(key), null));
ipcMain.handle("store:setSetting", (_e, key, value) => {
  const k = String(key);
  const v = value == null ? "" : String(value);
  if (v.length > MAX_SETTING_BYTES) throw new Error(`setting "${k}" exceeds ${MAX_SETTING_BYTES} bytes`);
  stmts.setSetting.run(k, v);
  return v;
});
ipcMain.handle("store:deleteSetting", (_e, key) => {
  const k = String(key);
  const r = db.prepare(`DELETE FROM settings WHERE key = ?`).run(k);
  return r.changes;
});

ipcMain.handle("bridge:getToken", () => getOrCreateBridgeToken());

// ──────────────── Candidates & digestion ──────────────────────────────
// A "candidate" is a chunk of text the user (via the Chrome extension)
// wants narrated *later*. Digestion = synthesizing all chunks of a
// candidate's text up front and persisting one merged WAV to disk; once
// digested the candidate is a one-click playback in the Queue view.

const CHUNK_TARGET = 600;
const CHUNK_HARD_LIMIT = 1200;

function chunkText(text) {
  const cleaned = (text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const re = /[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+\n+|[^.!?\n]+$/g;
  const sentences = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const piece = m[0].trim();
    if (piece) sentences.push(piece);
  }
  // Hard-split any individual sentence that's still too long (URLs, etc.).
  const expanded = [];
  for (const s of sentences) {
    if (s.length <= CHUNK_HARD_LIMIT) { expanded.push(s); continue; }
    let buf = "";
    for (const w of s.split(/\s+/)) {
      if (!w) continue;
      if (buf.length + w.length + 1 > CHUNK_HARD_LIMIT) {
        if (buf) expanded.push(buf);
        buf = w;
      } else {
        buf = buf ? buf + " " + w : w;
      }
    }
    if (buf) expanded.push(buf);
  }
  // Now pack sentences into ~CHUNK_TARGET-sized buckets.
  const chunks = [];
  let buf = "";
  for (const s of expanded) {
    if (!buf) buf = s;
    else if (buf.length + 1 + s.length <= CHUNK_TARGET) buf = buf + " " + s;
    else { chunks.push(buf); buf = s; }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// 16-bit PCM mono WAV encoder. Used to merge per-chunk Kokoro samples into
// a single playable file. Kokoro hands us Float32 samples in [-1, 1].
function encodeWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);         // 16-bit
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return Buffer.from(buf);
}

function digestsDir() {
  const dir = path.join(app.getPath("userData"), "digests");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// In-flight digestions, keyed by candidate id. We set .canceled to abort.
const activeDigests = new Map();

function broadcastCandidatesChanged() {
  broadcast("candidates:changed", { count: stmts.countCandidates.get().n });
}

function emitDigestProgress(id, payload) {
  broadcast("candidates:progress", { id, ...payload });
}

function addCandidateRow({ id, text, source, sourceUrl, title, timestamp }) {
  const row = {
    id: id || crypto.randomUUID(),
    text: String(text),
    source: source || "Extension",
    sourceUrl: sourceUrl ?? null,
    title: title ?? null,
    timestamp: timestamp || Date.now(),
  };
  stmts.addCandidate.run(row);
  broadcastCandidatesChanged();
  return row;
}

async function digestCandidate(id, voiceOverride, speedOverride) {
  if (activeDigests.has(id)) return; // already running
  const row = stmts.getCandidate.get(id);
  if (!row) throw new Error("candidate not found: " + id);
  if (row.status === "digested") return;

  // Pick a voice. Caller can override, otherwise fall back to the user's
  // last-selected voice (kokoro for now since that's the only ready engine).
  const voice = voiceOverride || row.voice || getSetting("selectedVoice", "af_heart");
  const speed = Number.isFinite(speedOverride) && speedOverride > 0 ? speedOverride : 1;

  if (modelStates.kokoro?.state !== "ready") {
    throw new Error("Kokoro is not loaded — open Model and wait for it to be ready");
  }

  const chunks = chunkText(row.text);
  if (chunks.length === 0) throw new Error("candidate has no text");

  const ctx = { canceled: false };
  activeDigests.set(id, ctx);
  stmts.setCandidateStatus.run({ id, status: "digesting", error: null });
  broadcastCandidatesChanged();
  emitDigestProgress(id, { state: "digesting", chunkIndex: 0, chunkCount: chunks.length });

  const t0 = Date.now();
  const allSamples = [];
  let totalSamples = 0;
  let samplingRate = null;

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (ctx.canceled) throw new Error("canceled");
      emitDigestProgress(id, { state: "digesting", chunkIndex: i, chunkCount: chunks.length });

      // The kokoro-js + phonemizer + onnxruntime pipeline trips a native trap
      // after enough back-to-back generate() calls (reliable around chunk ~9).
      // The KokoroClient turns that into a single rejection and respawns the
      // worker. Retry the chunk once so a single crash doesn't doom the whole
      // digest — the respawn reloads the model from local cache in ~0.6s.
      let audio;
      try {
        audio = await engines.kokoro.generate({ voice, text: chunks[i], speed });
      } catch (err) {
        if (!/worker crashed/i.test(err?.message ?? "")) throw err;
        console.warn(`[digest ${id}] chunk ${i} worker crashed; respawning + retrying once`);
        audio = await engines.kokoro.generate({ voice, text: chunks[i], speed });
      }

      if (ctx.canceled) throw new Error("canceled");
      // KokoroClient returns { samples: Float32Array, samplingRate, synthMs }.
      allSamples.push(audio.samples);
      totalSamples += audio.samples.length;
      samplingRate = audio.samplingRate;
    }

    // Flatten samples into one Float32Array (mono).
    const merged = new Float32Array(totalSamples);
    let off = 0;
    for (const arr of allSamples) { merged.set(arr, off); off += arr.length; }

    const wav = encodeWav(merged, samplingRate);
    const fileName = `${id}.wav`;
    const filePath = path.join(digestsDir(), fileName);
    fs.writeFileSync(filePath, wav);

    stmts.setCandidateDigested.run({
      id,
      voice,
      audioPath: fileName, // relative; resolved against digestsDir()
      durationSec: samplingRate ? totalSamples / samplingRate : null,
      size: wav.length,
      samplingRate,
      synthMs: Date.now() - t0,
      digestedAt: Date.now(),
    });
    broadcastCandidatesChanged();
    emitDigestProgress(id, { state: "digested", chunkIndex: chunks.length, chunkCount: chunks.length });
  } catch (err) {
    const msg = err?.message || String(err);
    const state = ctx.canceled ? "canceled" : "error";
    stmts.setCandidateStatus.run({ id, status: "pending", error: ctx.canceled ? null : msg });
    broadcastCandidatesChanged();
    emitDigestProgress(id, { state, error: msg });
    if (!ctx.canceled) throw err;
  } finally {
    activeDigests.delete(id);
  }
}

ipcMain.handle("candidates:list", () => stmts.listCandidates.all());
ipcMain.handle("candidates:delete", (_e, id) => {
  // Stop any in-flight digestion, then remove the row + any audio file.
  const ctx = activeDigests.get(String(id));
  if (ctx) ctx.canceled = true;
  const row = stmts.getCandidate.get(String(id));
  if (row?.audioPath) {
    try { fs.unlinkSync(path.join(digestsDir(), row.audioPath)); } catch {}
  }
  const r = stmts.deleteCandidate.run(String(id));
  broadcastCandidatesChanged();
  return r.changes;
});
ipcMain.handle("candidates:clear", () => {
  for (const ctx of activeDigests.values()) ctx.canceled = true;
  // Best-effort wipe of stored audio files.
  try {
    const dir = digestsDir();
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".wav")) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
  const r = stmts.clearCandidates.run();
  broadcastCandidatesChanged();
  return r.changes;
});
ipcMain.handle("candidates:digest", async (_e, { id, voice, speed }) => {
  await digestCandidate(String(id), voice || null, Number(speed) || null);
  return true;
});
ipcMain.handle("candidates:cancel", (_e, id) => {
  const ctx = activeDigests.get(String(id));
  if (!ctx) return false;
  ctx.canceled = true;
  return true;
});
ipcMain.handle("candidates:getAudio", (_e, id) => {
  const row = stmts.getCandidate.get(String(id));
  if (!row || row.status !== "digested" || !row.audioPath) {
    throw new Error("candidate has not been digested yet");
  }
  const filePath = path.join(digestsDir(), row.audioPath);
  const buf = fs.readFileSync(filePath);
  return {
    wav: new Uint8Array(buf),
    samplingRate: row.samplingRate,
    durationSec: row.durationSec,
    voice: row.voice,
  };
});

// ──────────────── HTTP bridge ─────────────────────────────────────────
// Loopback-only server that the Chrome extension calls to push text into
// the running app. Auth: a per-install token stored in settings; the user
// pastes it into the extension once during pairing.

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BRIDGE_MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-BoxTalk-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function tokenMatches(req, expected) {
  const got = req.headers["x-boxtalk-token"];
  if (typeof got !== "string" || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function startBridge() {
  const expectedToken = getOrCreateBridgeToken();
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    // Public health check — no token required so the extension can show a
    // "BoxTalk reachable" indicator without holding a paired token yet.
    if (req.method === "GET" && req.url === "/status") {
      sendJson(res, 200, {
        ok: true,
        kokoro: modelStates.kokoro?.state ?? "idle",
        paired: true,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/speak") {
      if (!tokenMatches(req, expectedToken)) {
        sendJson(res, 401, { error: "invalid token" });
        return;
      }
      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw);
      } catch (err) {
        sendJson(res, 400, { error: "invalid json: " + err.message });
        return;
      }
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "text required" });
        return;
      }
      const source = typeof payload?.source === "string" ? payload.source.slice(0, 80) : "Extension";
      const voice = typeof payload?.voice === "string" ? payload.voice : null;
      const requestId = crypto.randomUUID();
      focusWindow();
      broadcast("remote:speak", { requestId, text, source, voice });
      sendJson(res, 202, { ok: true, requestId, length: text.length });
      return;
    }

    // Save the payload as a "narration candidate" — the renderer's Queue view
    // surfaces these; the user picks one to speak later. No focusWindow() so
    // queueing from the browser stays unobtrusive.
    if (req.method === "POST" && req.url === "/candidates") {
      if (!tokenMatches(req, expectedToken)) {
        sendJson(res, 401, { error: "invalid token" });
        return;
      }
      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw);
      } catch (err) {
        sendJson(res, 400, { error: "invalid json: " + err.message });
        return;
      }
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "text required" });
        return;
      }
      const row = addCandidateRow({
        text,
        source: typeof payload?.source === "string" ? payload.source.slice(0, 80) : "Extension",
        sourceUrl: typeof payload?.sourceUrl === "string" ? payload.sourceUrl.slice(0, 2000) : null,
        title: typeof payload?.title === "string" ? payload.title.slice(0, 300) : null,
      });
      sendJson(res, 201, { ok: true, id: row.id });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.on("error", (err) => {
    console.error("[bridge] server error:", err.message);
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  });
  return server;
}

// ──────────────── Window ──────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 620,
    minHeight: 520,
    backgroundColor: "#f4f4f6",
    title: "BoxTalk",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile("dist/index.html");
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

let bridgeServer = null;

app.whenReady().then(() => {
  openDatabase();
  createWindow();
  bridgeServer = startBridge();
  for (const [id, cfg] of Object.entries(MODELS)) {
    if (cfg.autoLoad) loadKokoro();
  }
});

app.on("window-all-closed", () => {
  if (db) db.close();
  if (engines.vibevoice) engines.vibevoice.stop().catch(() => {});
  if (bridgeServer) bridgeServer.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
