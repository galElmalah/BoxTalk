// Reproduces the "digest kills Electron" crash. Boots the app, posts a long
// article through the bridge (same path the Chrome extension takes), clicks
// Digest in the Queue view, then waits and reports whether Electron survives.

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const MODEL_LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DIGEST_TIMEOUT_MS = 2 * 60 * 1000;

// Long-ish article (~4 KB) — enough chunks to reproduce a 10-20s crash window.
const ARTICLE = Array.from({ length: 14 }, (_, i) => (
  `Paragraph ${i + 1}. This is a synthetic article generated to stress the digest pipeline. ` +
  `Kokoro chunks input text on sentence boundaries and concatenates the resulting Float32 samples. ` +
  `If the phonemizer WASM module accumulates state badly across calls, this loop will crash the renderer or main process. `
)).join("\n\n");

async function main() {
  console.log("Launching Electron…");
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    timeout: 60_000,
  });
  const page = await app.firstWindow();

  page.on("pageerror", (e) => console.error("[pageerror]", e.message, e.stack || ""));
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.error(`[renderer ${t}]`, msg.text());
  });
  const proc = app.process();
  proc.on("exit", (code, signal) => console.error(`[electron exit] code=${code} signal=${signal}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[electron stderr] ${d}`));
  proc.stdout?.on("data", (d) => process.stdout.write(`[electron stdout] ${d}`));

  console.log("Waiting for Kokoro to be ready…");
  await page.waitForFunction(
    () => window.__tts?.ready === true || window.__tts?.loadError,
    null,
    { timeout: MODEL_LOAD_TIMEOUT_MS, polling: 500 },
  );
  const loadError = await page.evaluate(() => window.__tts.loadError);
  if (loadError) throw new Error("Kokoro load error: " + loadError);
  console.log("Kokoro ready.");

  // Pull the bridge token from the renderer so we can POST as the extension would.
  const token = await page.evaluate(() => window.bridge?.getToken?.() ?? null);
  if (!token) throw new Error("could not read bridge token from renderer");

  console.log(`Posting ${ARTICLE.length}-char article through the bridge…`);
  const postRes = await fetch("http://127.0.0.1:38219/candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxTalk-Token": await token },
    body: JSON.stringify({
      text: ARTICLE,
      source: "repro",
      title: "Repro digest crash",
    }),
  });
  console.log(`Bridge POST → ${postRes.status} ${postRes.statusText}`);
  if (!postRes.ok) throw new Error(await postRes.text());
  const { id } = await postRes.json();
  console.log(`Candidate created: ${id}`);

  // Trigger digest via the same IPC the renderer button uses.
  console.log("Triggering digest…");
  const digestPromise = page.evaluate(
    (cid) => window.queue.digest(cid, null),
    id,
  );

  // Poll candidate status every second for up to DIGEST_TIMEOUT_MS so we see
  // chunk progress. If Electron dies mid-digest, this evaluate() will reject.
  const start = Date.now();
  const tick = setInterval(async () => {
    try {
      const status = await page.evaluate(async (cid) => {
        const list = await window.queue.list();
        return list.find((c) => c.id === cid)?.status;
      }, id);
      console.log(`[t+${((Date.now() - start) / 1000).toFixed(1)}s] status=${status}`);
    } catch (e) {
      console.error(`[t+${((Date.now() - start) / 1000).toFixed(1)}s] POLL FAILED:`, e.message);
      clearInterval(tick);
    }
  }, 1500);

  try {
    await Promise.race([
      digestPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("digest timeout")), DIGEST_TIMEOUT_MS)),
    ]);
    console.log("Digest completed.");
  } catch (err) {
    console.error("Digest crashed/timed out:", err.message);
  } finally {
    clearInterval(tick);
  }

  await app.close().catch(() => {});
}

main().catch((err) => {
  console.error("\nRepro crashed:", err);
  process.exit(1);
});
