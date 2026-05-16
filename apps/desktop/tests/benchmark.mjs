// End-to-end TTS benchmark. Launches the real Electron app, waits for
// Kokoro to load, then runs the ~1000-word fixture through both the
// `serial` (current behavior) and `gapless` (synth-pipelined +
// WebAudio-scheduled) strategies. Prints a side-by-side comparison so we
// can see where serial wastes time (inter-chunk gaps, no overlap with
// playback) and confirm gapless eliminates it.
//
// Usage:
//   pnpm bench                # serial vs gapless, analytical (no playback)
//   pnpm bench -- --play      # also play audio so a human can verify
//                             #   smoothness; adds ~5–7 min wall time
//
// Default fixture is tests/fixtures/benchmark-1000w.txt; pick another with
// `--fixture <name>` (resolves to tests/fixtures/benchmark-<name>.txt).
// Available: `1000w` (default, literary prose), `litellm` (technical writeup
// with identifiers, code excerpts, version numbers — stresses pronunciation).

import { _electron as electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

const argv = process.argv.slice(2);
const args = new Set(argv);
const PLAY = args.has("--play") || args.has("-p");
function argValue(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const FIXTURE = argValue("fixture") || "1000w";
const BENCH_TEXT_PATH = path.join(__dirname, "fixtures", `benchmark-${FIXTURE}.txt`);
if (!fs.existsSync(BENCH_TEXT_PATH)) {
  console.error(`fixture not found: ${BENCH_TEXT_PATH}`);
  process.exit(1);
}

function fmt(n) {
  if (n == null) return "    —";
  return n.toFixed(0).padStart(5);
}
function fmtMs(n) {
  if (n == null) return "      —";
  return `${(n / 1000).toFixed(2).padStart(5)}s`;
}

function printResult(r) {
  console.log(`\n  strategy: ${r.strategy}   played: ${r.played}   chunks: ${r.chunkCount}`);
  console.log(`  TTFA: ${fmtMs(r.ttfaMs)}    total: ${fmtMs(r.totalMs)}    Σ synth: ${fmtMs(r.sumSynthMs)}    Σ audio: ${fmtMs(r.sumAudioMs)}    Σ gap: ${fmtMs(r.sumGapMs)}`);
  console.log(`  ┌─────┬───────┬──────────┬──────────┬──────────┬──────────┐`);
  console.log(`  │ idx │ chars │ synth ms │ audio ms │  gap ms  │ play@ms  │`);
  console.log(`  ├─────┼───────┼──────────┼──────────┼──────────┼──────────┤`);
  for (const c of r.chunks) {
    const idx = String(c.index).padStart(3);
    const chars = String(c.chars).padStart(5);
    const synth = fmt(c.synthMs);
    const audio = fmt(c.audioDurMs);
    const gap = fmt(c.gapBeforeMs);
    const play = fmt(c.playStartMs);
    console.log(`  │ ${idx} │ ${chars} │   ${synth}  │   ${audio}  │   ${gap}  │   ${play}  │`);
  }
  console.log(`  └─────┴───────┴──────────┴──────────┴──────────┴──────────┘`);
}

async function runOneStrategy({ text, strategy, play }) {
  // Fresh Electron per strategy so back-to-back generate() calls in run A
  // don't degrade the kokoro worker's state for run B. (We've observed
  // chunks 1+ in a long renderer sequence taking ~70% longer than chunk 0,
  // a separate bug — isolating runs keeps this benchmark comparison fair.)
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => console.error("[renderer error]", e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[renderer console]", msg.text());
    });

    await page.waitForFunction(
      () => window.__tts?.ready === true || window.__tts?.loadError,
      null,
      { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
    );
    const loadError = await page.evaluate(() => window.__tts.loadError);
    if (loadError) throw new Error(`model load failed: ${loadError}`);

    // Single tiny warmup so first-inference allocation cost doesn't land on
    // the measured chunk 0.
    await page.evaluate(() => window.tts.generate({
      modelId: "kokoro",
      voice: "af_heart",
      text: "hello.",
    }));

    const tBench = Date.now();
    const r = await page.evaluate(
      async ({ text, strategy, play }) =>
        window.__tts.benchmark({ text, strategy, play }),
      { text, strategy, play },
    );
    return { result: r, wallMs: Date.now() - tBench };
  } finally {
    await app.close();
  }
}

async function main() {
  const text = fs.readFileSync(BENCH_TEXT_PATH, "utf8");
  const wc = text.trim().split(/\s+/).length;
  console.log(`Loaded fixture: ${wc} words, ${text.length} chars`);
  console.log(`Playback: ${PLAY ? "ENABLED" : "disabled (analytical mode)"}`);

  const strategies = (arg("strategies") || "serial,gapless,stream").split(",").map(s => s.trim()).filter(Boolean);
  const results = {};
  for (const strategy of strategies) {
    console.log(`\n──── running ${strategy} (fresh Electron) ────`);
    const { result, wallMs } = await runOneStrategy({ text, strategy, play: PLAY });
    console.log(`  (wall: ${(wallMs / 1000).toFixed(1)}s)`);
    printResult(result);
    results[strategy] = result;
  }

  // ── summary ──
  console.log(`\n══════════════════ SUMMARY ══════════════════`);
  console.log(`  strategy │   TTFA   │   total   │ chunks │  Σ gap  │ Σ audio`);
  for (const strategy of strategies) {
    const r = results[strategy];
    if (!r) continue;
    console.log(`  ${strategy.padEnd(8)} │ ${fmtMs(r.ttfaMs)}  │ ${fmtMs(r.totalMs)}  │ ${String(r.chunkCount).padStart(6)} │ ${fmtMs(r.sumGapMs)} │ ${fmtMs(r.sumAudioMs)}`);
  }
  console.log(`══════════════════════════════════════════════\n`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

main().catch(async (err) => {
  console.error("\nBenchmark crashed:", err);
  process.exit(1);
});
