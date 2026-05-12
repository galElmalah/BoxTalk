// e2e smoke test: launches the real Electron app, waits for Kokoro to load,
// then generates a short clip with every voice. Fails (exit 1) if any voice
// errors or returns a suspiciously small WAV.
//
// Usage: npm run smoke

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_WAV_BYTES = 4000; // < 1KB would mean WAV header only / empty
const SMOKE_TEXT = "Hello, this is a smoke test.";

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

async function main() {
  console.log(`Launching Electron from ${projectRoot}`);
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    timeout: 60_000,
  });

  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("[renderer error]", e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[renderer console]", msg.text());
  });

  console.log("Waiting for Kokoro model to load (first run downloads ~80MB)...");
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      () => window.__tts?.ready === true || window.__tts?.loadError,
      null,
      { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
    );
  } catch (err) {
    await app.close();
    throw new Error(`model load timed out after ${MODEL_LOAD_TIMEOUT_MS / 1000}s`);
  }

  const loadError = await page.evaluate(() => window.__tts.loadError);
  if (loadError) {
    await app.close();
    throw new Error(`model load failed: ${loadError}`);
  }
  console.log(`Model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const voices = await page.evaluate(() => window.__tts.voices.map((v) => v.id));
  console.log(`\nTesting ${voices.length} voices:\n`);

  const results = [];
  for (const voice of voices) {
    const label = `  ${voice.padEnd(14)}`;
    process.stdout.write(label);
    const t1 = Date.now();
    try {
      const result = await page.evaluate(
        ({ v, t }) => window.__tts.generate(v, t),
        { v: voice, t: SMOKE_TEXT },
      );
      const elapsed = Date.now() - t1;
      if (result.size < MIN_WAV_BYTES) {
        throw new Error(`WAV too small: ${result.size} bytes`);
      }
      if (result.samplingRate !== 24000) {
        throw new Error(`unexpected sample rate: ${result.samplingRate}`);
      }
      console.log(
        `ok  ${fmt(result.size).padStart(8)} B  ${result.durationSec?.toFixed(2)}s audio  (${(elapsed / 1000).toFixed(1)}s)`,
      );
      results.push({ voice, ok: true, ...result, elapsedMs: elapsed });
    } catch (err) {
      console.log(`FAIL  ${err.message}`);
      results.push({ voice, ok: false, error: err.message });
    }
  }

  await app.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${passed}/${results.length} voices passed`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} failure(s):`);
    for (const f of failed) console.error(`  ${f.voice}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
