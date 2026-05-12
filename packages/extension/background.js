// Service worker: keyboard command + context menu entry points.
// Both flows extract the current selection from the active tab and POST it
// to the BoxTalk bridge. Errors surface as toolbar-badge red dot + notification.

import { speak, saveCandidate } from "./bridge.js";

const SPEAK_MENU = "boxtalk-speak-selection";
const SAVE_MENU = "boxtalk-save-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: SPEAK_MENU,
    title: "Speak with BoxTalk",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: SAVE_MENU,
    title: "Save selection to BoxTalk queue",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || "").trim();
  if (!text) return flashError(tab?.id, "No selection.");
  if (info.menuItemId === SPEAK_MENU) {
    sendToBridge(tab, { kind: "speak", text, source: tabSource(tab, "selection") });
  } else if (info.menuItemId === SAVE_MENU) {
    sendToBridge(tab, {
      kind: "save",
      text,
      source: tabSource(tab, "selection"),
      sourceUrl: tab?.url || null,
      title: tab?.title || null,
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "speak-selection") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const text = await readSelectionFromTab(tab.id);
  if (!text) return flashError(tab.id, "No selection.");
  sendToBridge(tab, { kind: "speak", text, source: tabSource(tab, "selection") });
});

async function readSelectionFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.getSelection()?.toString() || "").trim(),
    });
    return results?.[0]?.result || "";
  } catch (err) {
    console.error("[boxtalk] selection extract failed:", err);
    return "";
  }
}

async function sendToBridge(tab, payload) {
  try {
    if (payload.kind === "save") {
      await saveCandidate(payload);
    } else {
      await speak(payload);
    }
    await flashOk(tab?.id, payload.kind === "save" ? "+" : "✓");
  } catch (err) {
    console.error(`[boxtalk] ${payload.kind} failed:`, err);
    if (err.code === "NOT_PAIRED") {
      chrome.runtime.openOptionsPage();
    }
    await flashError(tab?.id, err.message);
  }
}

function tabSource(tab, mode) {
  if (!tab?.url) return `Extension (${mode})`;
  try {
    return `${new URL(tab.url).hostname} · ${mode}`;
  } catch {
    return `Extension (${mode})`;
  }
}

async function flashOk(tabId, glyph = "✓") {
  if (!tabId) return;
  await chrome.action.setBadgeText({ text: glyph, tabId });
  await chrome.action.setBadgeBackgroundColor({ color: "#1b8754", tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 1500);
}

async function flashError(tabId, msg) {
  if (tabId) {
    await chrome.action.setBadgeText({ text: "!", tabId });
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b", tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2500);
  }
  console.warn("[boxtalk]", msg);
}
