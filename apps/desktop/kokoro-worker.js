// Kokoro inference worker. Runs inside an Electron utilityProcess so that
// a native crash inside kokoro-js / phonemizer (WASM) / onnxruntime-node
// kills only this worker — the main process respawns it and the user-facing
// app stays alive.
//
// Protocol (structured-cloned over parentPort message channel):
//   parent → worker:
//     { type: "load",          reqId, hfId, dtype, device }
//     { type: "generate",      reqId, voice, text, speed }
//     { type: "stream",        reqId, voice, text, speed }
//     { type: "stream-cancel", reqId }
//   worker → parent:
//     { type: "ready",          reqId }
//     { type: "progress",       reqId, data }
//     { type: "result",         reqId, sampleBytes, sampleCount, samplingRate, synthMs }
//     { type: "stream-segment", reqId, segmentIndex, text,
//                               sampleBytes, sampleCount, samplingRate, synthMs }
//     { type: "stream-end",     reqId, segmentCount, totalSynthMs, canceled }
//     { type: "error",          reqId, message }

let tts = null;
let TextSplitterStream = null;
// Active streams keyed by reqId. Each entry is { canceled: bool }. The
// generate loop checks .canceled between segments so an in-flight stream
// can stop early without killing the process.
const activeStreams = new Map();

function send(msg) {
  process.parentPort?.postMessage(msg);
}

async function handle(msg) {
  const { type, reqId } = msg;
  try {
    if (type === "load") {
      // Redirect transformers.js's cache out of node_modules/.cache (which
      // lives inside app.asar in a packaged build and is unreadable by the
      // native ONNX loader — system error 20 / ENOTDIR). Point it at a
      // writable path supplied by main, typically ~/Library/Application
      // Support/BoxTalk/transformers-cache.
      if (msg.cacheDir) {
        const { env } = await import("@huggingface/transformers");
        env.cacheDir = msg.cacheDir;
        // Belt-and-braces: also prevent transformers from looking at the
        // bundled-with-asar .cache as a fallback.
        env.localModelPath = msg.cacheDir;
        env.allowLocalModels = true;
      }
      const mod = await import("kokoro-js");
      tts = await mod.KokoroTTS.from_pretrained(msg.hfId, {
        dtype: msg.dtype || "q8",
        device: msg.device || "cpu",
        progress_callback: (data) => send({ type: "progress", reqId, data }),
      });
      TextSplitterStream = mod.TextSplitterStream;
      send({ type: "ready", reqId });
      return;
    }

    if (type === "generate") {
      if (!tts) throw new Error("kokoro not loaded");
      const t0 = Date.now();
      const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed ?? 1 });
      // Send the raw Float32 samples — main encodes them as WAV when the
      // renderer needs one, or concatenates them for digest. Sending as a
      // Buffer over structured-clone avoids JSON-encoding the floats.
      const buf = Buffer.from(audio.audio.buffer, audio.audio.byteOffset, audio.audio.byteLength);
      send({
        type: "result",
        reqId,
        sampleBytes: buf,
        sampleCount: audio.audio.length,
        samplingRate: audio.sampling_rate,
        synthMs: Date.now() - t0,
      });
      return;
    }

    if (type === "stream") {
      if (!tts) throw new Error("kokoro not loaded");
      if (!TextSplitterStream) throw new Error("TextSplitterStream missing — model not loaded?");

      // Work around a kokoro-js bug: stream(string) builds an internal
      // TextSplitterStream but never close()s it, so the last sentence
      // hangs forever. Drive the splitter ourselves and close it.
      const splitter = new TextSplitterStream();
      splitter.push(msg.text);
      splitter.close();

      const state = { canceled: false };
      activeStreams.set(reqId, state);

      let segmentIndex = 0;
      const tAll0 = Date.now();
      try {
        for await (const { text: segText, audio } of tts.stream(splitter, {
          voice: msg.voice,
          speed: msg.speed ?? 1,
        })) {
          if (state.canceled) break;
          const tSeg = Date.now();
          const buf = Buffer.from(
            audio.audio.buffer,
            audio.audio.byteOffset,
            audio.audio.byteLength,
          );
          send({
            type: "stream-segment",
            reqId,
            segmentIndex,
            text: segText,
            sampleBytes: buf,
            sampleCount: audio.audio.length,
            samplingRate: audio.sampling_rate,
            // kokoro-js' iterator returns each yield after its synth completes,
            // so tSeg measures send-time, not synth-time. We approximate
            // per-segment synth as Date.now() - tAll0 - prior cumulative,
            // but for clarity just send 0 here; main times round-trip itself
            // if it cares. We do still send the cumulative total in stream-end.
            synthMs: 0,
            tSentAt: tSeg,
          });
          segmentIndex++;
        }
        send({
          type: "stream-end",
          reqId,
          segmentCount: segmentIndex,
          totalSynthMs: Date.now() - tAll0,
          canceled: state.canceled,
        });
      } finally {
        activeStreams.delete(reqId);
      }
      return;
    }

    if (type === "stream-cancel") {
      const state = activeStreams.get(reqId);
      if (state) state.canceled = true;
      return;
    }

    throw new Error("unknown message type: " + type);
  } catch (err) {
    activeStreams.delete(reqId);
    send({ type: "error", reqId, message: err?.message ?? String(err) });
  }
}

process.parentPort.on("message", (event) => {
  // Electron's utilityProcess wraps the value in event.data.
  handle(event.data ?? event);
});

process.on("uncaughtException", (err) => {
  console.error("[kokoro-worker] uncaught:", err?.stack || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[kokoro-worker] unhandled:", err?.stack || err);
});
