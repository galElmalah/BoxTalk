// Launch BoxTalk in Electron via Playwright and screenshot each view.
// Output: <repoRoot>/docs/screenshots/{queue,general,model,history,speak}.png
//
// Run: node packages/app/tests/screenshots.mjs

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");
const outDir = path.join(repoRoot, "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
  console.log(`Launching Electron from ${projectRoot}`);
  console.log(`Writing screenshots to ${outDir}\n`);

  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("[renderer error]", e.message));
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[test]")) console.log(t);
  });

  await page.waitForFunction(() => !!window.store);

  // Reset persisted UI + clear the existing queue/history so the screenshots
  // never accidentally publish the user's real content.
  await page.evaluate(async () => {
    await window.store.setSelectedVoice("af_heart");
    await window.queue?.clear();
    await window.store.clearHistory();
    for (const k of [
      "ui.view",
      "ui.expandedModels",
      "speakDraft.text",
      "speakDraft.speed",
      "queue.digestVoice",
    ]) {
      await window.store.deleteSetting(k);
    }
  });
  await page.reload();
  await page.waitForFunction(() => !!window.store);

  // Wait for the model to finish loading so the Model view shows "Ready".
  await page.waitForFunction(
    () => window.__tts?.ready === true || window.__tts?.loadError,
    null,
    { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
  );
  const loadError = await page.evaluate(() => window.__tts.loadError);
  if (loadError) console.error("[warn] model load error:", loadError);

  const win = await app.browserWindow(page);
  const resize = async () => {
    await win.evaluate((w) => {
      w.setContentSize(1280, 820);
      w.center();
    });
    await page.waitForTimeout(200);
  };
  await resize();

  const goto = async (target) => {
    await page.locator(`.nav-item[data-nav="${target}"]`).click();
    await page.waitForFunction(
      (t) => document.querySelector(".view.active")?.getAttribute("data-view") === t,
      target,
      { timeout: 3000 },
    );
    await page.waitForTimeout(250);
  };

  const snap = async (name) => {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ✓ ${name}.png`);
  };

  // Queue: drop a couple of demo candidates via the loopback bridge so the
  // hero screenshot isn't just the empty state.
  const token = await page.evaluate(() => window.bridge.getToken());
  const postCandidate = async (payload) => {
    const res = await fetch("http://127.0.0.1:38219/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BoxTalk-Token": token },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) console.error("postCandidate failed:", res.status, body);
    else console.log("  + candidate:", res.status, body.slice(0, 80));
  };
  await postCandidate({
    text: "BoxTalk reads any web page out loud, locally. Right-click selected text in Chrome and pick “Speak with BoxTalk”, or send the whole article from the extension popup.",
    source: "example.com",
    sourceUrl: "https://example.com/welcome",
    title: "Welcome to BoxTalk",
  });
  await postCandidate({
    text: "Kokoro is an 82M-parameter open-weights TTS model. The quantized version runs comfortably on a laptop CPU and ships with 13 English voices out of the box.",
    source: "huggingface.co",
    sourceUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
    title: "Kokoro — 82M open-weights TTS",
  });
  await goto("queue");
  // The broadcast appears to race with the renderer reload — force a reload so
  // useQueue does a fresh initial refresh against the DB that now has our rows.
  await page.reload();
  await page.waitForFunction(() => !!window.queue);
  await resize();
  await page.waitForFunction(
    () => document.querySelectorAll('.q-card').length >= 2,
    null,
    { timeout: 5000 },
  ).catch(() => console.warn("[warn] candidates didn't render — taking screenshot anyway"));
  await page.locator('.nav-item[data-nav="queue"]').click();
  await page.waitForTimeout(400);

  // Digest the shorter candidate so we can screenshot the digested transport.
  // The pending column still has one waiting card for visual contrast.
  if (!loadError) {
    const digestedId = await page.evaluate(async () => {
      const list = await window.queue.list();
      const target = list.find((x) => /Welcome to BoxTalk/.test(x.title));
      if (!target) return null;
      await window.queue.digest(target.id, null);
      return target.id;
    });
    if (digestedId) {
      console.log("  ⏳ digesting", digestedId);
      await page.waitForFunction(
        (id) => {
          const card = document.querySelector(`[data-id="${id}"]`);
          return card?.getAttribute("data-status") === "digested";
        },
        digestedId,
        { timeout: 120_000, polling: 250 },
      );
      console.log("  ✓ digested");

      // Start playback, let it run a few seconds so the seek bar shows progress,
      // then pause so the screenshot captures a stable mid-playback state.
      await page.evaluate(async (id) => {
        const card = document.querySelector(`[data-id="${id}"]`);
        const playBtn = card?.querySelector('[data-action="play"]');
        playBtn?.click();
      }, digestedId);
      await page.waitForTimeout(2200);
      await page.evaluate(async (id) => {
        const card = document.querySelector(`[data-id="${id}"]`);
        const pauseBtn = card?.querySelector('[data-action="pause"]');
        pauseBtn?.click();
      }, digestedId);
      await page.waitForTimeout(300);
    }
  }

  await snap("queue");

  await goto("general");
  // Mask the real pairing token before screenshotting — it shouldn't leak.
  await page.evaluate(() => {
    const el = document.getElementById("bridge-token");
    if (el) el.textContent = "BOXTALK-DEMO-PAIRING-TOKEN";
  });
  await page.waitForTimeout(100);
  await snap("general");

  await goto("model");
  await snap("model");

  await goto("history");
  await snap("history");

  await goto("speak");
  // Put a tiny bit of placeholder text so the view looks alive.
  await page.evaluate(() => {
    const ta = document.querySelector("#speak-text, textarea");
    if (ta) {
      ta.value = "Hello from BoxTalk — local TTS on your desktop.";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.waitForTimeout(150);
  await snap("speak");

  await app.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
