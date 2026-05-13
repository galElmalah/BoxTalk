// Kokoro inference worker. Runs inside an Electron utilityProcess so that
// a native crash inside kokoro-js / phonemizer (WASM) / onnxruntime-node
// kills only this worker — the main process respawns it and the user-facing
// app stays alive.
//
// Protocol (JSON over parentPort message channel):
//   parent → worker:
//     { type: "load",     reqId, hfId, dtype, device }
//     { type: "generate", reqId, voice, text, speed }
//   worker → parent:
//     { type: "ready",    reqId }
//     { type: "progress", reqId, data }   (model download progress)
//     { type: "result",   reqId, wav, samplingRate, samples, synthMs }
//     { type: "error",    reqId, message }

let tts = null;

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
      const { KokoroTTS } = await import("kokoro-js");
      tts = await KokoroTTS.from_pretrained(msg.hfId, {
        dtype: msg.dtype || "q8",
        device: msg.device || "cpu",
        progress_callback: (data) => send({ type: "progress", reqId, data }),
      });
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

    throw new Error("unknown message type: " + type);
  } catch (err) {
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
