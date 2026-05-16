// Node-only Kokoro synthesis benchmark harness. Bypasses Electron entirely —
// loads kokoro-js the same way the utilityProcess worker does and measures
// pure generation cost so we can iterate on the synth-speed side without
// the renderer + IPC overhead the Playwright bench measures.
//
// Subcommands (--exp NAME). Each experiment loads the model once and
// reports the metrics that matter for its question:
//
//   baseline    Default 4-chunk run at target=1500 chars. Sanity check.
//   scan        Chunk-size sweep (300/600/1000/1500/1800). Finds the
//               sustained-throughput sweet spot.
//   dtype       Reloads kokoro-js with each dtype (q8/q4/q4f16/fp16/fp32)
//               and re-runs the default 4-chunk bench. Lets us pick the
//               quality/speed tradeoff per model.
//   stream      Built-in kokoro-js stream() API vs the manual 4-chunk
//               approach. Measures TTFA (time-to-first-audio) per
//               sentence — the dominant UX metric.
//   sentences   Manual per-sentence generate() calls. Compares phonemizer
//               cost vs the built-in splitter; isolates whether stream()
//               adds latency beyond what we get DIY.
//   phonemize   generate() vs generate_from_ids() with pre-computed
//               input_ids. Isolates phonemize+tokenize fixed cost.
//   parallel    1 vs 2 vs 4 concurrent kokoro-js instances. ONNX intra-op
//               uses all cores by default, so we expect oversubscription
//               to hurt — measure to confirm.
//   all         Run every experiment in sequence.
//
// Usage:
//   pnpm bench:synth                       # baseline
//   pnpm bench:synth -- --exp scan
//   pnpm bench:synth -- --exp dtype --dtypes q8,q4,fp16
//   pnpm bench:synth -- --exp all
//   pnpm bench:synth -- --voice am_michael --hf-id ...

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkText } from "../src/lib/chunkText.js";
import { BENCH_CHUNK_OPTS } from "../src/lib/benchmark.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}
const FIXTURE = arg("fixture", "1000w");
const BENCH_TEXT_PATH = path.join(__dirname, "fixtures", `benchmark-${FIXTURE}.txt`);
if (!fs.existsSync(BENCH_TEXT_PATH)) {
  console.error(`fixture not found: ${BENCH_TEXT_PATH}`);
  process.exit(1);
}
const EXP = arg("exp", "baseline");
const DTYPE = arg("dtype", "q8");
const DEVICE = arg("device", "cpu");
const HF_ID = arg("hf-id", "onnx-community/Kokoro-82M-v1.0-ONNX");
const VOICE = arg("voice", "af_heart");
const DTYPES = arg("dtypes", "q8,q4,q4f16,fp16,fp32").split(",").map(s => s.trim());

// ── cache dir ─────────────────────────────────────────────────────────
function defaultCacheDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "BoxTalk", "transformers-cache");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || home, "BoxTalk", "transformers-cache");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "BoxTalk", "transformers-cache");
}
const CACHE_DIR = arg("cache-dir", defaultCacheDir());

// ── helpers ───────────────────────────────────────────────────────────
const now = () => Number(process.hrtime.bigint()) / 1e6;
const fmt = (n, w = 7) => (n == null ? "—".padStart(w) : n.toFixed(0).padStart(w));
const fmtSec = (n) => (n == null ? "      —" : `${(n / 1000).toFixed(2)}s`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length === 0 ? 0 : sum(xs) / xs.length);

function loadFixture() {
  const text = fs.readFileSync(BENCH_TEXT_PATH, "utf8");
  return { text, words: text.trim().split(/\s+/).length, chars: text.length };
}

async function loadKokoro({ dtype = DTYPE, device = DEVICE } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  env.localModelPath = CACHE_DIR;
  env.allowLocalModels = true;
  const { KokoroTTS, TextSplitterStream } = await import("kokoro-js");
  const t0 = now();
  const tts = await KokoroTTS.from_pretrained(HF_ID, { dtype, device });
  return { tts, TextSplitterStream, loadMs: now() - t0 };
}

async function synth(tts, text) {
  const t0 = now();
  const audio = await tts.generate(text, { voice: VOICE, speed: 1 });
  return {
    synthMs: now() - t0,
    audioMs: (audio.audio.length / audio.sampling_rate) * 1000,
    samples: audio.audio.length,
    samplingRate: audio.sampling_rate,
  };
}

function printChunkTable(chunks, results) {
  const totalChars = sum(chunks.map(c => c.length));
  const sumSynth = sum(results.map(r => r.synthMs));
  const sumAudio = sum(results.map(r => r.audioMs));
  console.log(`  ┌─────┬───────┬──────────┬──────────┬──────┐`);
  console.log(`  │ idx │ chars │ synth ms │ audio ms │ rtf  │`);
  console.log(`  ├─────┼───────┼──────────┼──────────┼──────┤`);
  for (let i = 0; i < chunks.length; i++) {
    const r = results[i];
    const idx = String(i).padStart(3);
    const c = String(chunks[i].length).padStart(5);
    const s = fmt(r.synthMs, 8);
    const a = fmt(r.audioMs, 8);
    const rtfi = (r.synthMs / r.audioMs).toFixed(2).padStart(4);
    console.log(`  │ ${idx} │ ${c} │ ${s} │ ${a} │ ${rtfi} │`);
  }
  console.log(`  └─────┴───────┴──────────┴──────────┴──────┘`);
  console.log(`  Σ synth ${fmtSec(sumSynth)}   Σ audio ${fmtSec(sumAudio)}   RTF ${(sumSynth/sumAudio).toFixed(2)}   throughput ${(totalChars/(sumSynth/1000)).toFixed(0)} chars/s`);
  return { sumSynth, sumAudio, totalChars };
}

async function warmup(tts) {
  await tts.generate("Hello, this is a warmup.", { voice: VOICE, speed: 1 });
}

// ── experiments ───────────────────────────────────────────────────────

async function expBaseline(state) {
  const { text } = state.fixture;
  const chunks = chunkText(text, BENCH_CHUNK_OPTS);
  console.log(`\n──────── baseline (${chunks.length} chunks @ target ${BENCH_CHUNK_OPTS.target}) ────────`);
  const results = [];
  for (const c of chunks) results.push(await synth(state.tts, c));
  return printChunkTable(chunks, results);
}

async function expScan(state) {
  const { text } = state.fixture;
  const sizes = [300, 600, 1000, 1500, 1800];
  const summary = [];
  for (const target of sizes) {
    const hardLimit = Math.max(target + 200, 1200);
    const chunks = chunkText(text, { target, hardLimit });
    console.log(`\n──────── scan target=${target} chars   (${chunks.length} chunks) ────────`);
    const results = [];
    for (const c of chunks) results.push(await synth(state.tts, c));
    const { sumSynth, sumAudio, totalChars } = printChunkTable(chunks, results);
    summary.push({ target, chunks: chunks.length, sumSynth, sumAudio, throughput: totalChars / (sumSynth / 1000) });
  }
  console.log(`\n  scan summary:`);
  console.log(`  target │ chunks │ Σ synth │ throughput`);
  for (const r of summary) {
    console.log(`  ${String(r.target).padStart(6)} │ ${String(r.chunks).padStart(6)} │ ${fmtSec(r.sumSynth).padStart(7)} │ ${r.throughput.toFixed(0).padStart(7)} c/s`);
  }
}

async function expDtype(state) {
  const { text } = state.fixture;
  const chunks = chunkText(text, BENCH_CHUNK_OPTS);
  console.log(`\n──────── dtype scan (${DTYPES.join(", ")}) ────────`);
  const summary = [];
  for (const dtype of DTYPES) {
    process.stdout.write(`  ${dtype.padEnd(7)} loading… `);
    let inst;
    try {
      inst = await loadKokoro({ dtype });
    } catch (err) {
      console.log(`SKIP (${err?.message?.split("\n")[0] ?? err})`);
      continue;
    }
    process.stdout.write(`(${(inst.loadMs/1000).toFixed(1)}s)  warmup… `);
    await warmup(inst.tts);
    process.stdout.write(`bench… `);
    const results = [];
    for (const c of chunks) results.push(await synth(inst.tts, c));
    const sumSynth = sum(results.map(r => r.synthMs));
    const sumAudio = sum(results.map(r => r.audioMs));
    const totalChars = sum(chunks.map(c => c.length));
    console.log(`Σ synth ${fmtSec(sumSynth)}   RTF ${(sumSynth/sumAudio).toFixed(2)}   ${(totalChars/(sumSynth/1000)).toFixed(0)} c/s`);
    summary.push({ dtype, loadMs: inst.loadMs, sumSynth, sumAudio, totalChars, perChunk: results.map(r => r.synthMs) });
  }
  console.log(`\n  dtype summary:`);
  console.log(`  dtype    │ load    │ Σ synth │ RTF  │ throughput │ first-chunk`);
  const sorted = [...summary].sort((a, b) => a.sumSynth - b.sumSynth);
  for (const r of sorted) {
    const rtf = (r.sumSynth / r.sumAudio).toFixed(2);
    const tput = (r.totalChars / (r.sumSynth / 1000)).toFixed(0);
    const tta = (r.perChunk[0] / 1000).toFixed(1) + "s";
    console.log(`  ${r.dtype.padEnd(7)}  │ ${fmtSec(r.loadMs).padStart(7)} │ ${fmtSec(r.sumSynth).padStart(7)} │ ${rtf} │ ${tput.padStart(5)} c/s │ ${tta.padStart(6)}`);
  }
}

async function expStream(state) {
  const { text, chars } = state.fixture;
  console.log(`\n──────── stream() — built-in per-sentence streaming ────────`);
  // NOTE: kokoro-js' stream(stringInput) builds a TextSplitterStream and
  // pushes the string but never calls close() on it, so the final
  // sentence(s) get stuck in the splitter buffer and the consumer hangs.
  // Work around by driving the splitter ourselves.
  const splitter = new state.TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const t0 = now();
  let firstAudioAt = null;
  let nSegments = 0;
  let sumAudio = 0;
  for await (const { text: t, audio } of state.tts.stream(splitter, { voice: VOICE, speed: 1 })) {
    if (firstAudioAt === null) firstAudioAt = now() - t0;
    nSegments++;
    sumAudio += (audio.audio.length / audio.sampling_rate) * 1000;
    if (nSegments <= 5 || nSegments % 5 === 0) {
      console.log(`  segment ${String(nSegments).padStart(3)}: ${(now() - t0).toFixed(0).padStart(6)} ms cum  · "${t.slice(0, 60).replace(/\s+/g, " ")}${t.length > 60 ? "…" : ""}"`);
    }
  }
  const totalSynth = now() - t0;
  console.log(`  ${nSegments} segments   TTFA ${fmtSec(firstAudioAt)}   Σ synth ${fmtSec(totalSynth)}   Σ audio ${fmtSec(sumAudio)}   RTF ${(totalSynth/sumAudio).toFixed(2)}   ${(chars/(totalSynth/1000)).toFixed(0)} c/s`);
  return { firstAudioAt, totalSynth, nSegments };
}

async function expSentences(state) {
  const { text, chars } = state.fixture;
  // Same sentence splitter as kokoro-js' stream() default behavior — sentences
  // separated by . ! ? \n. We use a simple regex; the goal is to verify whether
  // stream()'s built-in queue/coalescing has any cost beyond doing it ourselves.
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  console.log(`\n──────── sentences — manual per-sentence generate() (${sentences.length} sentences) ────────`);
  const t0 = now();
  const results = [];
  for (let i = 0; i < sentences.length; i++) {
    const r = await synth(state.tts, sentences[i]);
    results.push(r);
    if (i === 0) console.log(`  TTFA: ${fmtSec(r.synthMs)}`);
  }
  const sumSynth = sum(results.map(r => r.synthMs));
  const sumAudio = sum(results.map(r => r.audioMs));
  const meanSynth = mean(results.map(r => r.synthMs));
  console.log(`  ${sentences.length} sentences   mean synth ${fmtSec(meanSynth)}   Σ synth ${fmtSec(sumSynth)}   Σ audio ${fmtSec(sumAudio)}   RTF ${(sumSynth/sumAudio).toFixed(2)}   ${(chars/(sumSynth/1000)).toFixed(0)} c/s`);
}

async function expPhonemize(state) {
  const { text } = state.fixture;
  const chunks = chunkText(text, BENCH_CHUNK_OPTS);
  console.log(`\n──────── phonemize cost: generate() vs generate_from_ids() ────────`);
  // Pre-compute phonemes + input_ids by replicating what generate() does
  // internally, but timing the steps separately. We import the same helpers
  // via dynamic import of kokoro-js' phonemize path (not exposed — fall back
  // to: call generate() once per chunk and time generate_from_ids() with
  // cached input_ids on the second pass).
  //
  // Simpler: time generate() for each chunk, then time generate_from_ids()
  // for each chunk using a re-tokenization with the same tokenizer. The
  // phonemize cost is `generate() - generate_from_ids()` per chunk.
  const { tokenizer } = state.tts;

  // Pass 1: generate() and capture timings + reconstruct input_ids ahead of time.
  // We mimic kokoro-js' phonemize path indirectly by reusing its public API:
  // call generate() once, but ALSO precompute input_ids for the second pass.
  // To precompute input_ids we need to phonemize; phonemizer is exported by
  // 'phonemizer' npm pkg. Try importing it.
  let phonemize = null;
  try {
    const ph = await import("phonemizer");
    phonemize = ph.phonemize;
  } catch (err) {
    console.log(`  phonemizer pkg unavailable (${err.message}); falling back to whole-pipeline timings only`);
  }

  // Pass A: full generate() timings.
  const gFull = [];
  for (const c of chunks) gFull.push(await synth(state.tts, c));

  if (!phonemize) {
    const sumSynth = sum(gFull.map(r => r.synthMs));
    console.log(`  generate() full pipeline:    Σ ${fmtSec(sumSynth)}   mean ${fmtSec(mean(gFull.map(r => r.synthMs)))}`);
    return;
  }

  // Pass B: pre-phonemize per chunk, then time generate_from_ids().
  const preMs = [];
  const idsArr = [];
  for (const c of chunks) {
    const t0 = now();
    const phon = (await phonemize(c, "en-us")).join(" ");
    const { input_ids } = tokenizer(phon, { truncation: true });
    preMs.push(now() - t0);
    idsArr.push(input_ids);
  }

  const gFromIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const t0 = now();
    const audio = await state.tts.generate_from_ids(idsArr[i], { voice: VOICE, speed: 1 });
    gFromIds.push({ synthMs: now() - t0, audioMs: (audio.audio.length / audio.sampling_rate) * 1000 });
  }

  console.log(`  ┌─────┬───────┬─────────────┬─────────────────┬──────────┬───────┐`);
  console.log(`  │ idx │ chars │ generate ms │ generate_from_ms│ phon+tok │ ratio │`);
  console.log(`  ├─────┼───────┼─────────────┼─────────────────┼──────────┼───────┤`);
  for (let i = 0; i < chunks.length; i++) {
    const idx = String(i).padStart(3);
    const c = String(chunks[i].length).padStart(5);
    const g = fmt(gFull[i].synthMs, 11);
    const gi = fmt(gFromIds[i].synthMs, 15);
    const p = fmt(preMs[i], 8);
    const ratio = (preMs[i] / gFull[i].synthMs).toFixed(2);
    console.log(`  │ ${idx} │ ${c} │ ${g} │ ${gi} │ ${p} │ ${ratio.padStart(5)} │`);
  }
  console.log(`  └─────┴───────┴─────────────┴─────────────────┴──────────┴───────┘`);
  console.log(`  Σ generate()        ${fmtSec(sum(gFull.map(r => r.synthMs)))}`);
  console.log(`  Σ generate_from_ids ${fmtSec(sum(gFromIds.map(r => r.synthMs)))}`);
  console.log(`  Σ phonemize+tok     ${fmtSec(sum(preMs))}`);
}

async function expParallel(state) {
  const { text } = state.fixture;
  const chunks = chunkText(text, BENCH_CHUNK_OPTS);
  console.log(`\n──────── parallel sessions (1 / 2 / 4 instances) ────────`);

  // Run #1: sequential through state.tts (single session). Already what
  // baseline does; reuse the timing.
  console.log(`\n  --- 1 instance, serial ---`);
  const r1 = [];
  for (const c of chunks) r1.push(await synth(state.tts, c));
  const t1 = sum(r1.map(r => r.synthMs));
  console.log(`  Σ synth ${fmtSec(t1)}`);

  // Run #N: load N instances, dispatch chunks round-robin, await all.
  for (const N of [2, 4]) {
    if (N > chunks.length) continue;
    console.log(`\n  --- ${N} instances, parallel ---`);
    process.stdout.write(`  loading ${N} sessions… `);
    const t0load = now();
    const instances = [];
    for (let i = 0; i < N; i++) {
      const inst = await loadKokoro();
      await warmup(inst.tts);
      instances.push(inst.tts);
    }
    console.log(`(${((now() - t0load)/1000).toFixed(1)}s)`);

    const tStart = now();
    const promises = chunks.map((c, i) => synth(instances[i % N], c));
    const results = await Promise.all(promises);
    const wall = now() - tStart;
    const synthSum = sum(results.map(r => r.synthMs));
    console.log(`  wall ${fmtSec(wall)}   Σ synth ${fmtSec(synthSum)}   speedup vs 1x ${(t1/wall).toFixed(2)}×`);
  }
}

// Verifies (or disproves) the hypothesis that kokoro's tokenizer silently
// truncates long inputs. Generates audio for inputs of growing length and
// compares input_ids count vs audio duration; if a clean ceiling on either
// dimension appears, truncation is real.
async function expTruncation(state) {
  const { text } = state.fixture;
  // Cumulative slices of the fixture. Picked so the smallest is below the
  // suspected 510-token ceiling and the largest is comfortably over.
  const targets = [200, 400, 600, 800, 1200, 1600, 2000, 2500, 3500, 5000];
  console.log(`\n──────── truncation probe — input length vs realized audio ────────`);
  console.log(`  ┌──────┬──────────┬─────────┬──────────┬─────────────┐`);
  console.log(`  │ chars│ input_ids│ synth ms│ audio ms │ truncated?  │`);
  console.log(`  ├──────┼──────────┼─────────┼──────────┼─────────────┤`);
  let prevAudioMs = 0;
  let plateauHits = 0;
  for (const target of targets) {
    const slice = text.slice(0, target);
    const t0 = now();
    const audio = await state.tts.generate(slice, { voice: VOICE, speed: 1 });
    const synthMs = now() - t0;
    const audioMs = (audio.audio.length / audio.sampling_rate) * 1000;
    const grew = audioMs - prevAudioMs > 500;
    const flag = !grew && target > 200 ? "← PLATEAU" : "";
    if (!grew && target > 200) plateauHits++;
    prevAudioMs = audioMs;
    console.log(`  │ ${String(slice.length).padStart(4)} │        — │ ${fmt(synthMs, 7)} │ ${fmt(audioMs, 8)} │ ${flag.padEnd(11)} │`);
    if (plateauHits >= 2) {
      console.log(`  └──────┴──────────┴─────────┴──────────┴─────────────┘`);
      console.log(`  STOP: audio plateaued for 2 successive sizes — kokoro is truncating long inputs.`);
      return;
    }
  }
  console.log(`  └──────┴──────────┴─────────┴──────────┴─────────────┘`);
}

const EXPERIMENTS = {
  baseline: expBaseline,
  scan: expScan,
  dtype: expDtype,
  stream: expStream,
  sentences: expSentences,
  phonemize: expPhonemize,
  parallel: expParallel,
  truncation: expTruncation,
};

async function main() {
  const fixture = loadFixture();
  console.log(`Fixture: ${fixture.words} words, ${fixture.chars} chars`);
  console.log(`Model: ${HF_ID}   voice: ${VOICE}`);
  console.log(`Cache: ${CACHE_DIR}`);

  // dtype is loaded per-experiment when relevant. For all others, load once.
  const expsToRun = EXP === "all"
    ? ["baseline", "scan", "stream", "sentences", "phonemize", "parallel", "dtype"]
    : [EXP];

  for (const name of expsToRun) {
    const fn = EXPERIMENTS[name];
    if (!fn) {
      console.error(`unknown experiment: ${name}   (known: ${Object.keys(EXPERIMENTS).join(", ")})`);
      process.exit(2);
    }

    if (name === "dtype" || name === "parallel") {
      // These manage their own instances.
      console.log(`\n┌─ exp: ${name} ─`);
      await fn({ fixture });
      continue;
    }

    console.log(`\n┌─ exp: ${name} ─`);
    process.stdout.write(`  loading kokoro dtype=${DTYPE}… `);
    const { tts, TextSplitterStream, loadMs } = await loadKokoro();
    process.stdout.write(`(${(loadMs/1000).toFixed(1)}s)  warmup… `);
    const tWarm0 = now();
    await warmup(tts);
    console.log(`(${((now() - tWarm0)/1000).toFixed(1)}s)`);
    await fn({ tts, TextSplitterStream, fixture });
  }
}

main().catch((err) => {
  console.error("bench-synth crashed:", err?.stack || err);
  process.exit(1);
});
