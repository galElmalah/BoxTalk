// Main-side proxy for the Kokoro utilityProcess worker. Exposes the same
// surface that main.js used to get from kokoro-js directly (`load`,
// `generate`), but routes calls through the worker so a native crash in
// kokoro-js / phonemizer / onnxruntime-node only kills the worker.
//
// The worker is respawned automatically. Any in-flight requests when the
// worker dies are rejected with a clear "kokoro worker crashed" error.

const { utilityProcess } = require("electron");
const path = require("node:path");

const WORKER_PATH = path.join(__dirname, "kokoro-worker.js");
const WORKER_STARTUP_TIMEOUT_MS = 30_000;

class KokoroClient {
  constructor({ onProgress } = {}) {
    this.onProgress = onProgress;
    this.proc = null;
    this.ready = false;
    this.loaded = false;
    this.loadOpts = null; // remembered so we can re-load after a crash
    this.nextReqId = 1;
    this.pending = new Map(); // reqId → { resolve, reject }
    // Active streams keyed by reqId. Each entry is
    // { onSegment, onEnd, onError, resolve, reject }.
    this.streams = new Map();
  }

  // Spawn the worker. Idempotent: returns immediately if already running.
  async ensureWorker() {
    if (this.proc) return;

    const proc = utilityProcess.fork(WORKER_PATH, [], {
      serviceName: "kokoro",
      stdio: "pipe",
    });
    this.proc = proc;

    proc.stdout?.on("data", (d) => process.stdout.write(`[kokoro] ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[kokoro!] ${d}`));
    proc.on("message", (msg) => this.handleMessage(msg));
    proc.on("exit", (code) => this.handleExit(code));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("kokoro worker startup timeout")), WORKER_STARTUP_TIMEOUT_MS);
      proc.once("spawn", () => { clearTimeout(t); resolve(); });
      proc.once("exit", (code) => { clearTimeout(t); reject(new Error("kokoro worker exited before spawn: " + code)); });
    });
    this.ready = true;
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "progress") {
      this.onProgress?.(msg.data);
      return;
    }
    // Streaming protocol routes through this.streams; one-shot requests
    // route through this.pending.
    if (msg.type === "stream-segment") {
      const stream = this.streams.get(msg.reqId);
      if (!stream) return; // canceled or already torn down
      const bytes = msg.sampleBytes;
      const samples = new Float32Array(msg.sampleCount);
      new Uint8Array(samples.buffer).set(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      try {
        stream.onSegment?.({
          segmentIndex: msg.segmentIndex,
          text: msg.text,
          samples,
          samplingRate: msg.samplingRate,
        });
      } catch (err) {
        console.error("[kokoro] onSegment threw:", err);
      }
      return;
    }
    if (msg.type === "stream-end") {
      const stream = this.streams.get(msg.reqId);
      if (!stream) return;
      this.streams.delete(msg.reqId);
      try {
        stream.onEnd?.({
          segmentCount: msg.segmentCount,
          totalSynthMs: msg.totalSynthMs,
          canceled: !!msg.canceled,
        });
      } catch (err) {
        console.error("[kokoro] onEnd threw:", err);
      }
      stream.resolve({
        segmentCount: msg.segmentCount,
        totalSynthMs: msg.totalSynthMs,
        canceled: !!msg.canceled,
      });
      return;
    }
    if (msg.type === "error") {
      const stream = this.streams.get(msg.reqId);
      if (stream) {
        this.streams.delete(msg.reqId);
        const err = new Error(msg.message);
        stream.onError?.(err);
        stream.reject(err);
        return;
      }
    }
    const entry = this.pending.get(msg.reqId);
    if (!entry) return;
    this.pending.delete(msg.reqId);
    if (msg.type === "error") entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  }

  handleExit(code) {
    const reason = `kokoro worker exited (code=${code}); pending=${this.pending.size}, streams=${this.streams.size}`;
    console.error("[kokoro]", reason);
    const err = new Error("kokoro worker crashed: " + reason);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const stream of this.streams.values()) {
      try { stream.onError?.(err); } catch {}
      stream.reject(err);
    }
    this.streams.clear();
    this.proc = null;
    this.ready = false;
    this.loaded = false;
  }

  send(payload) {
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error("kokoro worker not running"));
        return;
      }
      this.pending.set(reqId, { resolve, reject });
      this.proc.postMessage({ ...payload, reqId });
    });
  }

  async load({ hfId, dtype = "q8", device = "cpu", cacheDir = null }) {
    this.loadOpts = { hfId, dtype, device, cacheDir };
    await this.ensureWorker();
    await this.send({ type: "load", hfId, dtype, device, cacheDir });
    this.loaded = true;
  }

  // If the worker died at some point, transparently respawn + reload before
  // each generate. Callers see a single generate() promise either way.
  // Returns { samples: Float32Array, samplingRate, synthMs }.
  async generate({ voice, text, speed }) {
    if (!this.proc) {
      if (!this.loadOpts) throw new Error("kokoro not loaded");
      console.warn("[kokoro] worker is down; respawning + reloading…");
      await this.load(this.loadOpts);
    }
    const result = await this.send({ type: "generate", voice, text, speed });
    // Reconstruct the Float32Array view over the transferred bytes. We copy
    // into a fresh Float32Array so callers can hold/concatenate without
    // worrying about the underlying ArrayBuffer alignment.
    const bytes = result.sampleBytes;
    const samples = new Float32Array(result.sampleCount);
    new Uint8Array(samples.buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return {
      samples,
      samplingRate: result.samplingRate,
      synthMs: result.synthMs,
    };
  }

  // Streaming generate. Resolves when the worker reports stream-end; rejects
  // on error or worker crash. `onSegment` is called per yielded sentence
  // with { segmentIndex, text, samples: Float32Array, samplingRate }.
  // Returns { cancel(): void, done: Promise<{segmentCount,totalSynthMs,canceled}> }.
  generateStream({ voice, text, speed, onSegment, onEnd, onError }) {
    if (!this.proc) {
      throw new Error("kokoro worker not running");
    }
    const reqId = this.nextReqId++;
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.streams.set(reqId, { onSegment, onEnd, onError, resolve, reject });
    this.proc.postMessage({ type: "stream", reqId, voice, text, speed });
    return {
      reqId,
      done,
      cancel: () => {
        if (this.streams.has(reqId) && this.proc) {
          try { this.proc.postMessage({ type: "stream-cancel", reqId }); } catch {}
        }
      },
    };
  }

  async stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { KokoroClient };
