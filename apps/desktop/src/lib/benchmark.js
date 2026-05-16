// Renderer-side TTS playback benchmarks. Two strategies:
//
//   serial   — current `speakSequence` behavior: synth chunk N, play to end,
//              then synth chunk N+1. Each chunk is a fresh <audio> element.
//              Inter-chunk silence ≈ synth time of chunk N+1, plus a small
//              decode/setup overhead.
//
//   gapless  — synth pipelined behind playback (chunks beyond 0 synth in
//              the background while earlier chunks play), and playback
//              scheduled sample-accurate via WebAudio AudioBufferSourceNode
//              .start(t) so chunks join with no gap and no boundary click.
//
// Both strategies return the same BenchResult shape so the Playwright
// runner can compare them directly.
//
// Driven via window.__tts.benchmark({ text, strategy, voice, modelId, play }).
//
// `play === false` (the default in CI) measures synth + scheduling math only
// and infers gap-vs-playback analytically from sample durations; `play ===
// true` plays through the speakers so a human can listen for the click/gap.

import { chunkText } from "./chunkText.js";

// Tuned so a ~1000-word fixture lands at 4 chunks. Real production chunking
// uses the smaller default (600 / 1200) — we override here to match the
// "4 chunks ≈ 1000 words" benchmark spec.
export const BENCH_CHUNK_OPTS = { target: 1500, hardLimit: 1800 };

export function chunkForBench(text, opts = BENCH_CHUNK_OPTS) {
  return chunkText(text, opts);
}

const now = () => performance.now();

function audioFromWav(wav) {
  const blob = new Blob([wav], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return { audio, url };
}

function disposeAudio(a, url) {
  if (a) { try { a.pause(); } catch {} a.src = ""; }
  if (url) URL.revokeObjectURL(url);
}

async function decodeWav(audioCtx, wav) {
  const u8 = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return audioCtx.decodeAudioData(ab);
}

// ── serial ─────────────────────────────────────────────────────────────
async function runSerial({ chunks, generate, play, modelId, voice }) {
  const chunkMetrics = [];
  const t0 = now();
  let ttfaMs = null;
  let prevEndedAt = null;
  let activeAudio = null;
  let activeUrl = null;

  for (let i = 0; i < chunks.length; i++) {
    const tSynth0 = now();
    const result = await generate({ modelId, voice, text: chunks[i] });
    const tSynth1 = now();
    const audioDurMs = (result.samples / result.samplingRate) * 1000;

    let playStartMs = null;
    let playEndedMs = null;
    let gapBeforeMs = null;

    if (play) {
      disposeAudio(activeAudio, activeUrl);
      const { audio, url } = audioFromWav(result.wav);
      activeAudio = audio;
      activeUrl = url;

      const ended = new Promise((resolve) => {
        audio.onended = () => { playEndedMs = now() - t0; resolve(); };
        audio.onerror = () => { playEndedMs = now() - t0; resolve(); };
      });
      await audio.play();
      playStartMs = now() - t0;
      if (ttfaMs === null) ttfaMs = playStartMs;
      gapBeforeMs = prevEndedAt === null ? null : playStartMs - prevEndedAt;
      await ended;
      prevEndedAt = playEndedMs;
    } else {
      // Serial-without-playback: model the gap. We assume audio playback
      // takes audioDurMs (true on real hardware), so chunk i+1's synth
      // starts at (synth_i_end + audioDurMs_i) and the gap before chunk i+1
      // is its own synth time.
      if (i > 0) gapBeforeMs = tSynth1 - tSynth0;
      if (ttfaMs === null) ttfaMs = tSynth1 - t0;
    }

    chunkMetrics.push({
      index: i,
      chars: chunks[i].length,
      synthMs: tSynth1 - tSynth0,
      audioDurMs,
      playStartMs,
      playEndedMs,
      gapBeforeMs,
    });
  }
  if (play) disposeAudio(activeAudio, activeUrl);

  const totalMs = play
    ? (chunkMetrics.at(-1).playEndedMs ?? (now() - t0))
    : chunkMetrics.reduce((a, c) => a + c.synthMs + c.audioDurMs, 0);

  return summarize("serial", play, chunks, chunkMetrics, ttfaMs, totalMs);
}

// ── gapless ────────────────────────────────────────────────────────────
async function runGapless({ chunks, generate, play, modelId, voice }) {
  const tBenchStart = now();

  // Pipeline synth requests via a chained promise. The kokoro worker
  // serves one generate() at a time, so the chain enforces correct
  // ordering at the JS layer (no interleaved messages to the worker)
  // while letting the renderer await each result independently.
  const synthMs = new Array(chunks.length).fill(0);
  let chain = Promise.resolve();
  const synthQueue = chunks.map((chunk, i) => {
    const p = chain.then(async () => {
      const t0 = now();
      const res = await generate({ modelId, voice, text: chunk });
      synthMs[i] = now() - t0;
      return res;
    });
    chain = p;
    return p;
  });

  let audioCtx = null;
  if (play) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
    if (audioCtx.state === "suspended") await audioCtx.resume();
  }

  const chunkMetrics = [];
  let ttfaMs = null;
  let scheduleTime = null; // AudioContext time of the next scheduled start
  let prevPlayEndMs = 0;   // analytical-mode bookkeeping
  let prevSynthDoneMs = 0; // analytical-mode bookkeeping

  for (let i = 0; i < chunks.length; i++) {
    const tWait0 = now();
    const result = await synthQueue[i];
    const synthWaitMs = now() - tWait0; // 0 if synth already finished
    const audioDurMs = (result.samples / result.samplingRate) * 1000;

    let playStartMs, playEndedMs, gapBeforeMs, decodeMs = null;

    if (play) {
      const tDec0 = now();
      const buf = await decodeWav(audioCtx, result.wav);
      decodeMs = now() - tDec0;

      if (scheduleTime === null) {
        // First chunk: schedule a hair in the future so the source node is
        // wired up before its start deadline.
        scheduleTime = audioCtx.currentTime + 0.05;
      }
      const idealStart = scheduleTime;
      // If synth slipped behind playback, the requested start is in the
      // past — clamp to currentTime and record the slip.
      const actualStart = Math.max(idealStart, audioCtx.currentTime);
      gapBeforeMs = i === 0 ? null : (actualStart - idealStart) * 1000;

      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(actualStart);

      const ctxNow = audioCtx.currentTime;
      const nowFromBench = now() - tBenchStart;
      playStartMs = nowFromBench + (actualStart - ctxNow) * 1000;
      playEndedMs = playStartMs + buf.duration * 1000;
      if (ttfaMs === null) ttfaMs = playStartMs;

      scheduleTime = actualStart + buf.duration;
    } else {
      // Analytical: synth happens serially in the background, so
      // synthDone_i = sum(synth_0..synth_i). Playback of chunk i begins at
      // max(prevPlayEnd, synthDone_i). Gap = max(0, synthDone_i - prevPlayEnd).
      const synthDoneMs = prevSynthDoneMs + synthMs[i];
      const playStart = i === 0 ? synthDoneMs : Math.max(prevPlayEndMs, synthDoneMs);
      gapBeforeMs = i === 0 ? null : Math.max(0, synthDoneMs - prevPlayEndMs);
      playStartMs = playStart;
      playEndedMs = playStart + audioDurMs;
      prevPlayEndMs = playEndedMs;
      prevSynthDoneMs = synthDoneMs;
      if (ttfaMs === null) ttfaMs = playStartMs;
    }

    chunkMetrics.push({
      index: i,
      chars: chunks[i].length,
      synthMs: synthMs[i],
      synthWaitMs,
      audioDurMs,
      playStartMs,
      playEndedMs,
      decodeMs,
      gapBeforeMs,
    });
  }

  // Wait for the last scheduled source to actually finish, then tear down.
  if (play && chunkMetrics.length) {
    const last = chunkMetrics.at(-1);
    const waitMs = Math.max(0, last.playEndedMs - (now() - tBenchStart) + 30);
    await new Promise((r) => setTimeout(r, waitMs));
    try { await audioCtx.close(); } catch {}
  }

  const totalMs = chunkMetrics.at(-1)?.playEndedMs ?? 0;
  return summarize("gapless", play, chunks, chunkMetrics, ttfaMs, totalMs);
}

function summarize(strategy, played, chunks, chunkMetrics, ttfaMs, totalMs) {
  return {
    strategy,
    played: !!played,
    chunkCount: chunks.length,
    ttfaMs,
    totalMs,
    chunks: chunkMetrics,
    sumSynthMs: chunkMetrics.reduce((a, c) => a + c.synthMs, 0),
    sumAudioMs: chunkMetrics.reduce((a, c) => a + c.audioDurMs, 0),
    sumGapMs: chunkMetrics.reduce((a, c) => a + (c.gapBeforeMs ?? 0), 0),
  };
}

// ── stream ─────────────────────────────────────────────────────────────
// Drives window.tts.stream (per-sentence streaming TTS via kokoro-js) and
// schedules each segment sample-accurately via WebAudio. This is the
// production path now; the bench reuses it so we have a measurable baseline.
async function runStream({ text, play, modelId, voice }) {
  if (!window.tts?.stream) throw new Error("window.tts.stream not available");
  const tBenchStart = now();
  const segments = [];
  let firstSegmentAt = null;

  let audioCtx = null;
  if (play) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
    if (audioCtx.state === "suspended") await audioCtx.resume();
  }
  let scheduleTime = null;

  const handle = window.tts.stream({
    modelId,
    voice,
    text,
    onSegment: async (seg) => {
      const t = now() - tBenchStart;
      if (firstSegmentAt === null) firstSegmentAt = t;
      const audioDurMs = (seg.samples / seg.samplingRate) * 1000;
      let decodeMs = null, playStartMs = null, playEndedMs = null, gapBeforeMs = null;
      if (play) {
        const tDec0 = now();
        const buf = await decodeWav(audioCtx, seg.wav);
        decodeMs = now() - tDec0;
        if (scheduleTime === null) scheduleTime = audioCtx.currentTime + 0.05;
        const idealStart = scheduleTime;
        const actualStart = Math.max(idealStart, audioCtx.currentTime);
        gapBeforeMs = segments.length === 0 ? null : (actualStart - idealStart) * 1000;
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        src.start(actualStart);
        const ctxNow = audioCtx.currentTime;
        playStartMs = (now() - tBenchStart) + (actualStart - ctxNow) * 1000;
        playEndedMs = playStartMs + buf.duration * 1000;
        scheduleTime = actualStart + buf.duration;
      } else {
        // Analytical: with gapless WebAudio scheduling each segment plays
        // immediately after the prior one (or at arrival if synth slipped
        // behind playback — which RTF=0.35 means never happens for kokoro).
        const prev = segments.at(-1);
        const idealStart = prev ? prev.playEndedMs : t; // first segment plays at arrival
        const actualStart = Math.max(t, idealStart);
        gapBeforeMs = prev ? Math.max(0, t - prev.playEndedMs) : null;
        playStartMs = actualStart;
        playEndedMs = actualStart + audioDurMs;
      }
      segments.push({
        index: seg.segmentIndex,
        chars: seg.text?.length ?? 0,
        text: seg.text,
        synthMs: null, // worker doesn't report per-segment synth time here
        audioDurMs,
        playStartMs,
        playEndedMs,
        decodeMs,
        gapBeforeMs,
      });
    },
  });

  const info = await handle.done;

  if (play && segments.length) {
    const last = segments.at(-1);
    const waitMs = Math.max(0, last.playEndedMs - (now() - tBenchStart) + 30);
    await new Promise((r) => setTimeout(r, waitMs));
    try { await audioCtx.close(); } catch {}
  }

  const totalMs = segments.at(-1)?.playEndedMs ?? 0;
  return {
    strategy: "stream",
    played: !!play,
    chunkCount: segments.length,
    ttfaMs: firstSegmentAt,
    totalMs,
    chunks: segments,
    sumSynthMs: info?.totalSynthMs ?? null,
    sumAudioMs: segments.reduce((a, c) => a + c.audioDurMs, 0),
    sumGapMs: segments.reduce((a, c) => a + (c.gapBeforeMs ?? 0), 0),
  };
}

// Public entry point. Routes to the requested strategy.
export async function runBenchmark({
  strategy = "serial",
  text,
  modelId = "kokoro",
  voice = "af_heart",
  play = false,
  chunkOpts = BENCH_CHUNK_OPTS,
} = {}) {
  if (!text || typeof text !== "string") throw new Error("text required");

  if (strategy === "stream") {
    const result = await runStream({ text, play, modelId, voice });
    result.textChars = text.length;
    result.voice = voice;
    result.modelId = modelId;
    return result;
  }

  if (!window.tts?.generate) throw new Error("window.tts.generate not available");
  const chunks = chunkForBench(text, chunkOpts);
  // Retry once on worker-crash, matching the digest path's behavior in
  // main.js (the kokoro-js + phonemizer + onnxruntime pipeline trips a
  // native trap intermittently; the worker auto-respawns).
  const generate = async (args) => {
    try {
      return await window.tts.generate(args);
    } catch (err) {
      if (!/worker crashed/i.test(err?.message ?? "")) throw err;
      console.warn("[bench] worker crashed; retrying once");
      return window.tts.generate(args);
    }
  };
  const fn = strategy === "gapless" ? runGapless : runSerial;
  const result = await fn({ chunks, generate, play, modelId, voice });
  result.chunkChars = chunks.map((c) => c.length);
  result.textChars = text.length;
  result.voice = voice;
  result.modelId = modelId;
  return result;
}
