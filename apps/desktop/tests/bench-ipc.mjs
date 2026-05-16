// IPC round-trip microbenchmark for the kokoro-worker → main payload.
//
// Production today: kokoro-worker.js builds `Buffer.from(audio.audio.buffer, …)`
// and calls `process.parentPort.postMessage(msg)` with NO transferList. The
// underlying ArrayBuffer is structured-cloned, i.e. copied. For long chunks
// (1500 chars → ~15s of 24kHz mono audio → ~1.4 MB per chunk) and ~11 chunks
// per digest, that's ~15 MB of unnecessary copying per digest.
//
// This bench uses node:worker_threads.MessageChannel, which goes through the
// same V8 serializer as Electron utilityProcess's parentPort.postMessage. The
// per-byte serialization cost will be representative, though the absolute
// numbers in Electron may differ by a small constant.
//
// Modes:
//   copy        Float32Array → postMessage(msg)                  (production)
//   transfer    Float32Array → postMessage(msg, [arrayBuffer])   (zero-copy)
//   shared      Pre-shared SharedArrayBuffer, only send offset+len (no payload)
//
// Sizes chosen to bracket real kokoro chunks at 24kHz mono:
//   100KB ≈ 1.0s audio    (very short chunk)
//   500KB ≈ 5.2s audio    (medium chunk, ~300 char chunk)
//   1MB   ≈ 10.4s audio   (~600 char chunk — current digest default)
//   3MB   ≈ 31s  audio    (~1500 char chunk — BENCH_CHUNK_OPTS)
//   10MB                  (stress)

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const ROLE = process.env.IPC_BENCH_ROLE;

if (ROLE === "worker") {
  // Worker thread: echo back whatever we receive, with optional transfer.
  const { parentPort } = await import("node:worker_threads");
  parentPort.on("message", (msg) => {
    const { id, mode, samples, sharedBuf, len } = msg;
    if (mode === "copy") {
      parentPort.postMessage({ id, samples });
    } else if (mode === "transfer") {
      parentPort.postMessage({ id, samples }, [samples.buffer]);
    } else if (mode === "shared") {
      // Worker would normally write into sharedBuf and respond with just
      // (offset, len). We simulate the response — no data movement at all.
      parentPort.postMessage({ id, len });
    }
  });
} else {
  // Main: spawn worker, run the matrix.
  const SIZES = [
    { label: "100 KB",  samples: 25_000 },     //  ~1.0s audio
    { label: "500 KB",  samples: 125_000 },    //  ~5.2s audio
    { label: "1 MB",    samples: 250_000 },    // ~10.4s audio  (current digest chunk avg)
    { label: "3 MB",    samples: 750_000 },    // ~31s  audio   (BENCH_CHUNK_OPTS chunk avg)
    { label: "10 MB",   samples: 2_500_000 },  // stress
  ];
  const MODES = ["copy", "transfer", "shared"];
  const ITERS = 50;
  const WARMUP = 5;

  const worker = new Worker(__filename, {
    env: { ...process.env, IPC_BENCH_ROLE: "worker" },
  });
  let nextId = 1;
  const pending = new Map();
  worker.on("message", (msg) => {
    const r = pending.get(msg.id);
    if (!r) return;
    pending.delete(msg.id);
    r(msg);
  });

  function send(payload, transferList) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, ...payload }, transferList);
    });
  }

  function ms() { return Number(process.hrtime.bigint()) / 1e6; }

  // Pre-allocate a SharedArrayBuffer big enough for the largest payload.
  const shared = new SharedArrayBuffer(SIZES.at(-1).samples * 4);
  // (Worker side has its own view; in real code we'd hand it over once at boot.)

  console.log("\n── IPC round-trip microbench (Float32Array, Node worker_threads MessageChannel)");
  console.log(`   iters=${ITERS} (after ${WARMUP} warmup)   sample size = 4 bytes`);
  console.log("");
  console.log("   size     mode       mean ms   p50 ms   p95 ms   MB/s");
  console.log("   ───────  ─────────  ───────   ──────   ──────   ─────");

  const results = [];
  for (const { label, samples: N } of SIZES) {
    for (const mode of MODES) {
      const times = [];
      for (let i = 0; i < ITERS + WARMUP; i++) {
        // Build fresh Float32Array each iter so transfer mode doesn't reuse
        // a detached buffer. Real kokoro returns a fresh Float32Array per
        // generate() too, so this is faithful.
        const arr = new Float32Array(N);
        // Sprinkle some data so the serializer can't optimize an all-zero path.
        arr[0] = Math.random();
        arr[N - 1] = Math.random();

        const t0 = ms();
        if (mode === "copy") {
          await send({ mode, samples: arr });
        } else if (mode === "transfer") {
          await send({ mode, samples: arr }, [arr.buffer]);
        } else if (mode === "shared") {
          // In a real implementation, kokoro would write into `shared` and we'd
          // pass just length. Here we measure that round trip — pure protocol cost.
          await send({ mode, sharedBuf: shared, len: N });
        }
        const t1 = ms();
        if (i >= WARMUP) times.push(t1 - t0);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      const p50 = times[Math.floor(times.length * 0.5)];
      const p95 = times[Math.floor(times.length * 0.95)];
      const bytes = N * 4;
      const mbps = mean > 0 ? (bytes / (mean / 1000)) / (1024 * 1024) : 0;
      results.push({ label, mode, mean, p50, p95, mbps });
      console.log(
        `   ${label.padEnd(7)}  ${mode.padEnd(9)}  ${mean.toFixed(2).padStart(7)}   ${p50.toFixed(2).padStart(6)}   ${p95.toFixed(2).padStart(6)}   ${mbps.toFixed(0).padStart(5)}`
      );
    }
    console.log("");
  }

  // Per-digest projection: assume an 11-chunk digest where each chunk produces
  // ~1 MB of audio (today's ~600-char chunking) or ~3 MB (with BENCH_CHUNK_OPTS).
  const projections = [
    { name: "11 × 1 MB  (today's digest, ~600-char chunks)", per: results.filter(r => r.label === "1 MB"), chunks: 11 },
    { name: " 4 × 3 MB  (digest with BENCH_CHUNK_OPTS=1500)", per: results.filter(r => r.label === "3 MB"), chunks: 4 },
  ];
  console.log("── per-digest IPC cost projection ─────────────────────────");
  for (const p of projections) {
    console.log(`   ${p.name}:`);
    for (const r of p.per) {
      console.log(`     ${r.mode.padEnd(9)}  ${(r.mean * p.chunks).toFixed(1).padStart(6)} ms total`);
    }
    console.log("");
  }

  await worker.terminate();
}
