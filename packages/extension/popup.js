// Popup logic: status check, mode toggle, preview extraction, send-to-BoxTalk.
//
// Two modes:
//   - "selection": grabs window.getSelection() from the active tab.
//   - "page":      runs Mozilla Readability on a clone of the document and
//                  uses .textContent of the article body.
// Whichever is active, the user can hand-edit the preview before sending.

import { speak, saveCandidate, status, getToken } from "./bridge.js";

const $ = (id) => document.getElementById(id);
const preview = $("preview");
const speakBtn = $("speak-btn");
const saveBtn = $("save-btn");
const refreshBtn = $("refresh-btn");
const modeSelection = $("mode-selection");
const modePage = $("mode-page");
const statusDot = $("status-dot");
const metaCounts = $("meta-counts");
const metaError = $("meta-error");
const openOptions = $("open-options");
const pairedStatus = $("paired-status");

let mode = "selection";
let activeTab = null;
let articleTitle = null;

init().catch((err) => setError(err.message));

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  refreshStatus();
  refreshToken();
  await loadPreview();

  preview.addEventListener("input", updateCounts);
  speakBtn.addEventListener("click", onSpeak);
  saveBtn.addEventListener("click", onSave);
  refreshBtn.addEventListener("click", loadPreview);
  modeSelection.addEventListener("click", () => setMode("selection"));
  modePage.addEventListener("click", () => setMode("page"));
  openOptions.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  modeSelection.classList.toggle("active", mode === "selection");
  modePage.classList.toggle("active", mode === "page");
  modeSelection.setAttribute("aria-selected", mode === "selection");
  modePage.setAttribute("aria-selected", mode === "page");
  loadPreview();
}

async function loadPreview() {
  setError("");
  preview.value = "";
  preview.placeholder = "Extracting…";
  speakBtn.disabled = true;
  saveBtn.disabled = true;
  articleTitle = null;
  if (!activeTab?.id || isInternalUrl(activeTab.url)) {
    preview.placeholder = "Open a regular web page to use BoxTalk.";
    return;
  }

  try {
    if (mode === "selection") {
      const text = await extractSelection(activeTab.id);
      preview.value = text;
      preview.placeholder = "Select text on the page and click ↻ to refresh.";
    } else {
      const { title, text } = await extractReadability(activeTab.id);
      articleTitle = title || null;
      preview.value = [title, text].filter(Boolean).join("\n\n").trim();
      preview.placeholder = "Readability didn't find article content on this page.";
    }
    updateCounts();
  } catch (err) {
    setError(err.message || String(err));
    preview.placeholder = "Extraction failed.";
  }
}

async function extractSelection(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (window.getSelection()?.toString() || "").trim(),
  });
  return (results?.[0]?.result || "").trim();
}

async function extractReadability(tabId) {
  // Inject Readability + a small runner that posts the result back via
  // chrome.runtime.sendMessage. Using files: requires this round-trip
  // because files: doesn't return values from the page world.
  const reply = waitForRuntimeMessage("boxtalk:extracted", tabId, 8000);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["vendor/Readability.js", "extract-readability.js"],
  });
  const result = await reply;
  if (!result.ok) throw new Error(result.error || "Readability returned no article");
  return { title: result.title || "", text: result.text || "" };
}

function waitForRuntimeMessage(type, tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("extraction timed out"));
    }, timeoutMs);
    const listener = (msg, sender) => {
      if (msg?.type !== type) return;
      if (tabId != null && sender.tab?.id !== tabId) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg.payload);
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function onSpeak() {
  const text = preview.value.trim();
  if (!text) return;
  speakBtn.disabled = true;
  saveBtn.disabled = true;
  setError("");
  try {
    await speak({ text, source: `${tabHost()} · ${mode}` });
    window.close();
  } catch (err) {
    speakBtn.disabled = false;
    saveBtn.disabled = false;
    setError(err.message || String(err));
  }
}

async function onSave() {
  const text = preview.value.trim();
  if (!text) return;
  speakBtn.disabled = true;
  saveBtn.disabled = true;
  setError("");
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = "Saving…";
  try {
    await saveCandidate({
      text,
      source: `${tabHost()} · ${mode}`,
      sourceUrl: activeTab?.url || null,
      title: articleTitle || activeTab?.title || null,
    });
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => window.close(), 600);
  } catch (err) {
    saveBtn.textContent = originalLabel;
    speakBtn.disabled = false;
    saveBtn.disabled = false;
    setError(err.message || String(err));
  }
}

function tabHost() {
  try { return new URL(activeTab.url).hostname; } catch { return "page"; }
}

function isInternalUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|view-source):/i.test(url);
}

function updateCounts() {
  const text = preview.value.trim();
  if (!text) {
    metaCounts.textContent = "";
    speakBtn.disabled = true;
    saveBtn.disabled = true;
    return;
  }
  const chars = text.length;
  const chunks = Math.max(1, Math.ceil(chars / 600));
  metaCounts.textContent = `${chars.toLocaleString()} chars · ${chunks} chunk${chunks > 1 ? "s" : ""}`;
  speakBtn.disabled = false;
  saveBtn.disabled = false;
}

function setError(msg) {
  metaError.textContent = msg || "";
}

async function refreshStatus() {
  statusDot.classList.remove("status-ok", "status-err");
  statusDot.classList.add("status-unknown");
  statusDot.title = "Checking BoxTalk app…";
  const s = await status();
  statusDot.classList.remove("status-unknown");
  if (s.ok) {
    statusDot.classList.add("status-ok");
    statusDot.title = `BoxTalk reachable — Kokoro: ${s.kokoro || "?"}`;
  } else {
    statusDot.classList.add("status-err");
    statusDot.title = `BoxTalk unreachable: ${s.reason || "unknown error"}`;
  }
}

async function refreshToken() {
  const t = await getToken();
  pairedStatus.textContent = t ? "Paired" : "Not paired";
  pairedStatus.style.color = t ? "var(--ok)" : "var(--err)";
}
