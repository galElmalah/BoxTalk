// End-to-end Playwright test for the full user flow:
//   1. App boots, sidebar visible, model loads (status pill goes Ready).
//   2. Sidebar nav switches views (Speak / General / Model / History).
//   3. Speak view: type text, click Speak, audio playback state turns on,
//      and a history entry is recorded.
//   4. Model view: pick a different voice, return to Speak, generate again,
//      and history reflects the new voice.
//   5. History view: search filters entries; clear empties them.
//   6. General view: shows the selected model.
//
// Run: npm run e2e

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const GEN_TIMEOUT_MS = 90_000;

let passes = 0;
let failures = 0;
const results = [];

async function step(name, fn) {
  process.stdout.write(`  ${name.padEnd(60)} `);
  const t0 = Date.now();
  try {
    await fn();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`ok  (${elapsed}s)`);
    passes++;
    results.push({ name, ok: true });
  } catch (err) {
    console.log(`FAIL\n      ${err.message}`);
    failures++;
    results.push({ name, ok: false, error: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

async function main() {
  console.log(`Launching Electron from ${projectRoot}\n`);
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

  // Clean slate: wait for preload, then wipe SQLite-backed history, queue, and
  // any persisted UI state (view, expanded models, draft text, run modes).
  await page.waitForFunction(() => !!window.store);
  await page.evaluate(async () => {
    await window.store.clearHistory();
    await window.queue?.clear();
    await window.store.setMaxHistory(20);
    await window.store.setSelectedVoice("af_heart");
    for (const k of ["ui.view", "ui.expandedModels", "speakDraft.text", "speakDraft.speed"]) {
      await window.store.deleteSetting(k);
    }
  });
  await page.reload();
  await page.waitForFunction(() => !!window.store);

  try {
    await step("app shell renders (sidebar, BoxTalk name, default Queue view)", async () => {
      const appName = await page.textContent(".app-name");
      assert(appName?.trim() === "BoxTalk", `app name was "${appName}"`);

      const navCount = await page.locator(".nav-item").count();
      assert(navCount === 5, `expected 5 nav items, got ${navCount}`);

      const activeView = await page.locator(".view.active").getAttribute("data-view");
      assert(activeView === "queue", `default view was "${activeView}"`);
    });

    await step("model loads (Kokoro card state goes loading → ready, no wave when ready)", async () => {
      await page.waitForFunction(
        () => window.__tts?.ready === true || window.__tts?.loadError,
        null,
        { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
      );
      const loadError = await page.evaluate(() => window.__tts.loadError);
      assert(!loadError, `model load error: ${loadError}`);

      await page.locator('.nav-item[data-nav="model"]').click();
      const stateAttr = await page.locator('[data-model="kokoro"] .model-state').getAttribute("data-state");
      assert(stateAttr === "ready", `kokoro state was "${stateAttr}"`);

      // The wave only renders while loading; after ready it is gone.
      const waveCount = await page.locator('[data-model="kokoro"] .model-state .wave').count();
      assert(waveCount === 0, `expected no wave when ready, got ${waveCount}`);

      // Progress block only renders during loading.
      const progCount = await page.locator('[data-model="kokoro"] .model-progress-inline').count();
      assert(progCount === 0, `expected no progress row when ready, got ${progCount}`);
    });

    await step("sidebar nav switches views (queue → general → model → history → speak)", async () => {
      const goto = async (target) => {
        await page.locator(`.nav-item[data-nav="${target}"]`).click();
        await page.waitForFunction(
          (t) => document.querySelector(".view.active")?.getAttribute("data-view") === t,
          target,
          { timeout: 2000 },
        );
        const activeNav = await page.locator(`.nav-item[data-nav="${target}"]`).getAttribute("class");
        assert(activeNav?.includes("active"), `nav "${target}" missing active class`);
      };
      await goto("general");
      await goto("model");
      await goto("history");
      await goto("speak");
    });

    await step("General view shows the selected model", async () => {
      await page.locator('.nav-item[data-nav="general"]').click();
      const txt = await page.locator("#general-model").textContent();
      assert(/Kokoro/.test(txt || ""), `general model text was "${txt}"`);
    });

    await step("Model view lists all voices and marks the default active", async () => {
      await page.locator('.nav-item[data-nav="model"]').click();
      const count = await page.locator(".voice-option").count();
      assert(count === 13, `expected 13 voice options, got ${count}`);
      const activeId = await page.locator(".voice-option.active").getAttribute("data-voice");
      assert(activeId === "af_heart", `default active voice was "${activeId}"`);
      const previewCount = await page.locator(".preview-btn").count();
      assert(previewCount === 13, `expected 13 preview buttons, got ${previewCount}`);
    });

    await step("Voice preview plays a sample without selecting the voice or adding history", async () => {
      await page.locator('.nav-item[data-nav="model"]').click();
      const before = await page.evaluate(() => ({
        selected: window.__tts.getSelectedVoice(),
        historyLen: window.__tts.getHistory().length,
      }));

      await page.locator('.preview-btn[data-preview="bf_isabella"]').click();

      // Preview starts playing.
      await page.waitForFunction(
        () => window.__tts.previewState?.playing === true,
        null,
        { timeout: GEN_TIMEOUT_MS, polling: 200 },
      );
      const previewing = await page.evaluate(() => window.__tts.previewState.voice);
      assert(previewing === "bf_isabella", `previewState.voice was "${previewing}"`);

      // Button shows playing state.
      const btnClass = await page.locator('.preview-btn[data-preview="bf_isabella"]').getAttribute("class");
      assert(btnClass?.includes("playing"), `preview button class was "${btnClass}"`);

      // Selection and history must NOT be touched by the preview.
      const after = await page.evaluate(() => ({
        selected: window.__tts.getSelectedVoice(),
        historyLen: window.__tts.getHistory().length,
      }));
      assert(after.selected === before.selected, `selection changed: ${before.selected} → ${after.selected}`);
      assert(after.historyLen === before.historyLen, `history changed: ${before.historyLen} → ${after.historyLen}`);

      // Clicking the same button again stops the preview.
      await page.locator('.preview-btn[data-preview="bf_isabella"]').click();
      await page.waitForFunction(
        () => window.__tts.previewState?.playing === false,
        null,
        { timeout: 3000 },
      );
    });

    await step("Speak: type text, click Speak, wave appears, audio plays, history records", async () => {
      await page.locator('.nav-item[data-nav="speak"]').click();
      const text = "Hello from the end to end test.";
      await page.locator("#text").fill(text);

      // Reset playback-state tracker so we know this run set it.
      await page.evaluate(() => {
        window.__tts.playbackState = { playing: false };
        window.__tts.lastEvent = null;
      });

      await page.locator("#speak").click();

      // The Speak button enters .busy state showing the wave while synthesizing.
      await page.waitForFunction(() => document.getElementById("speak")?.classList.contains("busy"), null, {
        timeout: 2000,
        polling: 30,
      });

      // Wait for synthesis + playback to start.
      await page.waitForFunction(
        () => window.__tts.playbackState?.playing === true,
        null,
        { timeout: GEN_TIMEOUT_MS, polling: 200 },
      );

      // Once playing, the busy class is removed.
      const stillBusy = await page.locator("#speak.busy").count();
      assert(stillBusy === 0, "Speak button should no longer be in busy state once playing");

      const ev = await page.evaluate(() => window.__tts.lastEvent);
      assert(ev, "no lastEvent recorded");
      assert(ev.text === text, `lastEvent.text mismatch: "${ev.text}"`);
      assert(ev.voice === "af_heart", `lastEvent.voice was "${ev.voice}"`);
      assert(ev.size > 4000, `lastEvent.size too small: ${ev.size}`);
      assert(ev.samplingRate === 24000, `samplingRate was ${ev.samplingRate}`);
      assert(ev.source === "Manual", `source was "${ev.source}"`);

      const history = await page.evaluate(() => window.__tts.getHistory());
      assert(history.length >= 1, `history length was ${history.length}`);
      assert(history[0].text === text, `most recent history.text was "${history[0].text}"`);
    });

    await step("Stop button halts playback", async () => {
      await page.locator("#stop").click();
      await page.waitForFunction(() => window.__tts.playbackState?.playing === false, null, {
        timeout: 5000,
      });
    });

    await step("Model: switching voice updates Speak view and persists selection", async () => {
      await page.locator('.nav-item[data-nav="model"]').click();
      await page.locator('.voice-option[data-voice="bm_george"]').click();

      const activeId = await page.locator(".voice-option.active").getAttribute("data-voice");
      assert(activeId === "bm_george", `active voice was "${activeId}"`);

      await page.locator('.nav-item[data-nav="speak"]').click();
      const label = await page.locator("#current-voice-label").textContent();
      assert(/George/.test(label || ""), `speak label was "${label}"`);
    });

    await step("Speak again with new voice; history records it", async () => {
      await page.locator("#text").fill("Cheerio, this is the second test.");
      await page.evaluate(() => {
        window.__tts.playbackState = { playing: false };
        window.__tts.lastEvent = null;
      });
      await page.locator("#speak").click();
      await page.waitForFunction(
        () => window.__tts.playbackState?.playing === true,
        null,
        { timeout: GEN_TIMEOUT_MS, polling: 200 },
      );
      const ev = await page.evaluate(() => window.__tts.lastEvent);
      assert(ev?.voice === "bm_george", `lastEvent.voice was "${ev?.voice}"`);

      const history = await page.evaluate(() => window.__tts.getHistory());
      assert(history.length === 2, `expected 2 history entries, got ${history.length}`);
      assert(history[0].voice === "bm_george", `newest history voice was "${history[0].voice}"`);
      assert(history[1].voice === "af_heart", `oldest history voice was "${history[1].voice}"`);
    });

    await step("History view shows both entries with source + synthesis-time tags", async () => {
      await page.locator("#stop").click().catch(() => {});
      await page.locator('.nav-item[data-nav="history"]').click();
      const itemCount = await page.locator(".history-item").count();
      assert(itemCount === 2, `expected 2 history items in DOM, got ${itemCount}`);
      const firstSource = await page.locator(".history-item .tag.source").first().textContent();
      assert(firstSource?.trim() === "Manual", `first source tag was "${firstSource}"`);
      const firstItemText = await page.locator(".history-item").first().textContent();
      assert(/generated in/.test(firstItemText || ""), `first item missing synth-time tag: "${firstItemText}"`);
      assert(/audio/.test(firstItemText || ""), `first item missing audio duration tag: "${firstItemText}"`);
    });

    await step("History persists in SQLite (survives reload)", async () => {
      await page.reload();
      await page.waitForFunction(() => !!window.store);
      await page.waitForFunction(() => window.__tts?.ready === true, null, { timeout: 60_000 });
      const len = await page.evaluate(() => window.__tts.getHistory().length);
      assert(len === 2, `expected 2 entries after reload, got ${len}`);
    });

    await step("History search filters entries", async () => {
      await page.locator('.nav-item[data-nav="history"]').click();
      await page.locator("#history-search").fill("Cheerio");
      const count = await page.locator(".history-item").count();
      assert(count === 1, `expected 1 filtered item, got ${count}`);
      const text = await page.locator(".history-item .h-text").first().textContent();
      assert(/Cheerio/.test(text || ""), `filtered text was "${text}"`);

      // Empty state on a non-matching search.
      await page.locator("#history-search").fill("zzznomatchzzz");
      await page.waitForFunction(
        () => document.querySelectorAll(".history-item").length === 0,
        null,
        { timeout: 2000 },
      );
      const emptyVisible = await page.locator("#history-empty.visible").count();
      assert(emptyVisible === 1, "empty state not visible after no-match search");

      // Clear the search to restore.
      await page.locator("#history-search").fill("");
      const restored = await page.locator(".history-item").count();
      assert(restored === 2, `after clearing search expected 2, got ${restored}`);
    });

    await step("General: max-history defaults to 20 and truncates when lowered", async () => {
      await page.locator('.nav-item[data-nav="general"]').click();
      const defaultVal = await page.locator("#max-history").inputValue();
      assert(defaultVal === "20", `default max-history was "${defaultVal}"`);

      // Lower the cap to 1 — older of the two history entries should drop in SQLite.
      await page.locator("#max-history").fill("1");
      await page.locator("#max-history").press("Tab");
      await page.waitForFunction(() => window.__tts.getHistory().length === 1, null, { timeout: 3000 });

      const stored = await page.evaluate(() => window.store.getMaxHistory());
      assert(stored === 1, `expected stored max to be 1, got ${stored}`);

      // Reset to default for clean teardown.
      await page.locator("#max-history").fill("20");
      await page.locator("#max-history").press("Tab");
    });

    await step("History clear empties the list", async () => {
      await page.locator('.nav-item[data-nav="history"]').click();
      await page.locator("#history-clear").click();
      await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 0, null, { timeout: 3000 });
      const stored = await page.evaluate(() => window.__tts.getHistory().length);
      assert(stored === 0, `expected stored history to be empty, got ${stored}`);
    });

    await step("Selected voice persists across reload", async () => {
      await page.reload();
      await page.waitForFunction(
        () => window.__tts?.ready === true || window.__tts?.loadError,
        null,
        { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
      );
      const v = await page.evaluate(() => window.__tts.getSelectedVoice());
      assert(v === "bm_george", `persisted voice was "${v}"`);
      const label = await page.locator("#current-voice-label").textContent();
      assert(/George/.test(label || ""), `speak label after reload was "${label}"`);
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.error(`\nFailures:`);
    for (const r of results.filter((r) => !r.ok)) console.error(`  - ${r.name}: ${r.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nE2E crashed:", err);
  process.exit(1);
});
