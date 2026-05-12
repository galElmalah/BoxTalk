// VibeVoice backend — wraps the vibevoice.cpp CLI as a per-call subprocess.
//
// Upstream:  https://github.com/localai-org/vibevoice.cpp
// Models:    https://huggingface.co/mudler/vibevoice.cpp-models
//
// Lifecycle:
//   loadModel(id) — downloads the GGUF files this model needs from HuggingFace
//                   into <userData>/vibevoice/models/, emitting progress.
//   generate(...) — spawns `vibevoice-cli tts ...` with the cached files,
//                   reads the output WAV, returns it.
//
// The CLI binary must be built from source once (see scripts/build-vibevoice.mjs).
// We resolve its path in this order:
//   1. process.env.VIBEVOICE_CLI
//   2. <repo>/vendor/vibevoice.cpp/build/bin/vibevoice-cli
//   3. `vibevoice-cli` on PATH
//
// Only Realtime-0.5B is supported with pre-published GGUFs today (Carter +
// Emma voices). 1.5B and 7B require manual conversion of the upstream
// Microsoft weights — we surface a friendly error if a user tries to load them.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const os = require("node:os");

const HF_REPO = "mudler/vibevoice.cpp-models";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const VIBEVOICE_REPO = "https://github.com/localai-org/vibevoice.cpp";

// Per-model dispatch table. `files` lists the GGUFs we download; `voices`
// maps UI voice ids → voice-gguf filename (realtime path uses pre-baked
// voice files). `cliBuild` returns the argv for `vibevoice-cli tts`.
const MODEL_RECIPE = {
  "vibevoice-realtime": {
    files: [
      "tokenizer.gguf",
      "vibevoice-realtime-0.5B-q8_0.gguf",
      "voice-en-Carter_man.gguf",
      "voice-en-Emma.gguf",
    ],
    voiceMap: {
      vv05_carter: "voice-en-Carter_man.gguf",
      vv05_emma:   "voice-en-Emma.gguf",
    },
    cliBuild: ({ modelsDir, voice, text, outPath }) => [
      "tts",
      "--model",     path.join(modelsDir, "vibevoice-realtime-0.5B-q8_0.gguf"),
      "--tokenizer", path.join(modelsDir, "tokenizer.gguf"),
      "--voice",     path.join(modelsDir, voice),
      "--text",      text,
      "--out",       outPath,
    ],
  },
  "vibevoice-1.5b": {
    unavailable:
      "VibeVoice 1.5B GGUFs are not yet pre-published. To enable: clone " +
      "localai-org/vibevoice.cpp and run scripts/convert_vibevoice_to_gguf.py " +
      "against microsoft/VibeVoice-1.5B (~11 GB), then drop the gguf into " +
      "<userData>/vibevoice/models/.",
  },
  "vibevoice-large": {
    unavailable:
      "VibeVoice 7B GGUFs are not yet pre-published. The upstream weights live " +
      "on a ModelScope mirror and require manual conversion via vibevoice.cpp's " +
      "scripts/convert_vibevoice_to_gguf.py.",
  },
};

class VibeVoiceBackend {
  constructor({ userDataDir, onProgress }) {
    this.modelsDir = path.join(userDataDir, "vibevoice", "models");
    this.tmpDir = path.join(userDataDir, "vibevoice", "tmp");
    this.onProgress = onProgress;
    this.cliPath = null; // resolved on first use
  }

  async start() {
    await fsp.mkdir(this.modelsDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
  }

  async stop() {
    // Stateless — nothing to stop. Subprocesses are short-lived per call.
  }

  resolveCli() {
    if (this.cliPath) return this.cliPath;

    const candidates = [
      // Honor explicit override first.
      process.env.VIBEVOICE_CLI,
      // Packaged: electron-builder's extraResources copies the binary under
      // Contents/Resources/. process.resourcesPath only exists in a packaged app.
      process.resourcesPath ? path.join(process.resourcesPath, "vibevoice-cli") : null,
      // Dev: built from source into ./vendor/.
      path.join(__dirname, "vendor", "vibevoice.cpp", "build", "bin", "vibevoice-cli"),
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        this.cliPath = p; // memoize only on success
        return p;
      }
    }

    // Final fallback: PATH lookup. Don't memoize — if the user builds the
    // binary while the app is running, the next call should pick it up.
    return "vibevoice-cli";
  }

  // Clone + build vibevoice.cpp under ./vendor/ if the binary is missing.
  // Streams progress to onProgress so the model card shows what's happening.
  async ensureBinary(modelId) {
    const target = path.join(__dirname, "vendor", "vibevoice.cpp", "build", "bin", "vibevoice-cli");
    if (fs.existsSync(target)) {
      this.cliPath = target;
      return target;
    }

    // Pre-flight: surface a friendly error if git or cmake are missing,
    // instead of getting an obscure ENOENT mid-build.
    for (const tool of ["git", "cmake", "make"]) {
      if (!(await onPath(tool))) {
        throw new Error(
          `${tool} not found on PATH. The VibeVoice backend builds from source the ` +
          `first time you load a model. Install Xcode Command Line Tools ` +
          `(\`xcode-select --install\`) or your platform's equivalent.`,
        );
      }
    }

    const repoDir = path.join(__dirname, "vendor", "vibevoice.cpp");
    const vendorDir = path.dirname(repoDir);
    await fsp.mkdir(vendorDir, { recursive: true });

    if (!fs.existsSync(repoDir)) {
      this.onProgress?.(modelId, {
        stage: "building vibevoice.cpp",
        file: "cloning sources",
        progress: null,
      });
      await runStreaming("git", ["clone", "--recursive", VIBEVOICE_REPO, repoDir]);
    }

    this.onProgress?.(modelId, {
      stage: "building vibevoice.cpp",
      file: "cmake configure",
      progress: null,
    });
    await runStreaming("cmake", ["-B", "build", "-DCMAKE_BUILD_TYPE=Release"], { cwd: repoDir });

    this.onProgress?.(modelId, {
      stage: "building vibevoice.cpp",
      file: "compiling (0%)",
      progress: 0,
    });
    await runStreaming("cmake", ["--build", "build", "-j"], {
      cwd: repoDir,
      onLine: (line) => {
        const m = /\[\s*(\d+)%\]/.exec(line);
        if (m) {
          const pct = parseInt(m[1], 10);
          this.onProgress?.(modelId, {
            stage: "building vibevoice.cpp",
            file: `compiling (${pct}%)`,
            progress: pct,
          });
        }
      },
    });

    if (!fs.existsSync(target)) {
      throw new Error(`build finished but ${target} is missing`);
    }
    this.cliPath = target;
    return target;
  }

  async loadModel(modelId /*, hfId — ignored: ggufs come from mudler/vibevoice.cpp-models */) {
    const recipe = MODEL_RECIPE[modelId];
    if (!recipe) throw new Error("unknown vibevoice model: " + modelId);
    if (recipe.unavailable) throw new Error(recipe.unavailable);

    await this.start();

    // 1. Make sure the CLI binary exists. First-time builds emit progress
    //    through onProgress so the model card shows a compile bar.
    await this.ensureBinary(modelId);

    // First, learn each file's size so we can show a single combined
    // download bar across the model. HEAD requests are cheap.
    const sizes = await Promise.all(recipe.files.map((f) => headSize(`${HF_BASE}/${f}`)));
    const totalBytes = sizes.reduce((a, b) => a + b, 0);

    let downloaded = 0;
    for (let i = 0; i < recipe.files.length; i++) {
      const filename = recipe.files[i];
      const sizeBytes = sizes[i];
      const dest = path.join(this.modelsDir, filename);

      if (await exists(dest) && (await fsp.stat(dest)).size === sizeBytes) {
        downloaded += sizeBytes;
        this.onProgress?.(modelId, {
          stage: "cached",
          file: filename,
          loaded: downloaded,
          total: totalBytes,
          progress: totalBytes ? (downloaded / totalBytes) * 100 : null,
        });
        continue;
      }

      await this.downloadOne({
        modelId,
        url: `${HF_BASE}/${filename}`,
        dest,
        filename,
        sizeBytes,
        startBytes: downloaded,
        totalBytes,
      });
      downloaded += sizeBytes;
    }

    this.onProgress?.(modelId, {
      stage: "complete",
      loaded: totalBytes,
      total: totalBytes,
      progress: 100,
    });
  }

  async downloadOne({ modelId, url, dest, filename, sizeBytes, startBytes, totalBytes }) {
    const tmp = dest + ".part";
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch ${url} → ${res.status}`);

    let fileLoaded = 0;
    const reportEvery = Math.max(64 * 1024, Math.floor(sizeBytes / 200)); // ~0.5% steps
    let nextReport = reportEvery;

    const reporter = new TransformStream({
      transform: (chunk, controller) => {
        fileLoaded += chunk.byteLength;
        if (fileLoaded >= nextReport || fileLoaded === sizeBytes) {
          nextReport += reportEvery;
          const totalSoFar = startBytes + fileLoaded;
          this.onProgress?.(modelId, {
            stage: "downloading",
            file: filename,
            loaded: totalSoFar,
            total: totalBytes,
            progress: totalBytes ? (totalSoFar / totalBytes) * 100 : null,
          });
        }
        controller.enqueue(chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(reporter)),
      fs.createWriteStream(tmp),
    );
    await fsp.rename(tmp, dest);
  }

  async generate({ modelId, voice, text }) {
    const recipe = MODEL_RECIPE[modelId];
    if (!recipe) throw new Error("unknown vibevoice model: " + modelId);
    if (recipe.unavailable) throw new Error(recipe.unavailable);

    const voiceFile = recipe.voiceMap[voice];
    if (!voiceFile) throw new Error(`voice ${voice} not configured for ${modelId}`);

    const outPath = path.join(this.tmpDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const args = recipe.cliBuild({ modelsDir: this.modelsDir, voice: voiceFile, text, outPath });
    const cli = this.resolveCli();

    const t0 = Date.now();
    await runCli(cli, args);
    const synthMs = Date.now() - t0;

    const wavBuf = await fsp.readFile(outPath);
    fsp.unlink(outPath).catch(() => {});

    const { samplingRate, samples } = readWavMeta(wavBuf);
    return {
      wav: new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength),
      samplingRate,
      samples,
      synthMs,
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

async function headSize(url) {
  // HF redirects HEAD/GET both to CDN; HEAD is enough to pick up
  // Content-Length on the CDN response.
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) throw new Error(`HEAD ${url} → ${res.status}`);
  const len = res.headers.get("content-length");
  return len ? parseInt(len, 10) : 0;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function onPath(cmd) {
  return new Promise((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const p = spawn(which, [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

// Spawn a long-running command, surface stdout+stderr line-by-line via
// onLine. Resolves on exit 0, rejects with a helpful error including the
// last bit of stderr on non-zero exit.
function runStreaming(cmd, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const recentErr = [];

    const handle = (chunk, isErr) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (isErr) {
          recentErr.push(line);
          if (recentErr.length > 30) recentErr.shift();
        }
        onLine?.(line);
      }
    };

    proc.stdout.on("data", (c) => handle(c, false));
    proc.stderr.on("data", (c) => handle(c, true));
    proc.on("error", (e) => {
      if (e.code === "ENOENT") reject(new Error(`${cmd} not found on PATH`));
      else reject(e);
    });
    proc.on("exit", (code) => {
      if (code === 0) return resolve();
      const tail = recentErr.slice(-10).join("\n").trim() || "(no stderr)";
      reject(new Error(`${cmd} exited ${code}: ${tail}`));
    });
  });
}

function runCli(cli, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", (e) => {
      if (e.code === "ENOENT") {
        reject(new Error(
          `vibevoice-cli not found at "${cli}". Build it with:\n` +
          `  npm run build:vibevoice\n` +
          `or set VIBEVOICE_CLI to an existing binary.`,
        ));
      } else reject(e);
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      else reject(new Error(`vibevoice-cli exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
    });
  });
}

// Tiny WAV header parser — just enough to surface sample rate + sample count
// without pulling in a wav library. PCM16 mono is what vibevoice-cli emits.
function readWavMeta(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { samplingRate: 24000, samples: 0 };
  }
  const samplingRate = buf.readUInt32LE(24);
  // Find the "data" chunk header
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const bitsPerSample = buf.readUInt16LE(34);
      const channels = buf.readUInt16LE(22);
      const bytesPerSample = (bitsPerSample / 8) * channels;
      return { samplingRate, samples: bytesPerSample ? size / bytesPerSample : 0 };
    }
    off += 8 + size;
  }
  return { samplingRate, samples: 0 };
}

module.exports = { VibeVoiceBackend, VibeVoiceSidecar: VibeVoiceBackend };
