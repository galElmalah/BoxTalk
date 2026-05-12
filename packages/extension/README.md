# @boxtalk/extension

Chrome (MV3) extension that captures web page content and POSTs it to the running BoxTalk desktop app for voice-over.

## Install (development)

```bash
pnpm install          # also vendors Readability.js into vendor/
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick the `packages/extension/` directory.
4. Open the BoxTalk desktop app → **General → Browser extension** → copy the pairing token.
5. Click the extension icon → **Settings** → paste the token → **Save**.

## Two modes

- **Selection** — three ways in, all do the same thing (post the highlighted text):
  - Right-click a selection → **Speak with BoxTalk**.
  - Keyboard shortcut: `Cmd/Ctrl+Shift+S`.
  - Click the toolbar icon → **Selection** tab → preview the highlighted text → **Speak now**.
- **Whole page** — toolbar icon → **Whole page** tab. Runs Mozilla [Readability](https://github.com/mozilla/readability) on a clone of the live DOM (same algorithm as Firefox Reader View) and shows the article body so you can trim or edit before sending. The desktop app handles chunking large inputs.

## Two actions

For each mode you can choose between two endpoints:

- **Speak now** — POST to `/speak`. The desktop app brings itself to the front, chunks the text, and starts reading immediately. Each chunk lands as a history entry tagged with the page hostname.
- **Save for later** — POST to `/candidates`. Stored silently in the desktop app's **Queue** view (Waiting column) with the source URL and page title. In the desktop app you press *Digest* to pre-render the audio file, then *Play* whenever you want — the desktop app never steals focus during save.

Both actions are available from the popup. Selection mode also exposes both from the right-click context menu (*Speak with BoxTalk* / *Save selection to BoxTalk queue*).

## Status dot

The popup pings `GET /status` on the bridge to show a green/red connection indicator. If it's red, make sure the desktop app is running.

## Files

```
manifest.json            MV3 manifest. Service worker is type: module.
background.js            Context-menu + Cmd+Shift+S handlers.
bridge.js                Shared client for the loopback bridge.
popup.html / .js / .css  Toolbar popup with both modes.
extract-readability.js   Content script (paired with vendor/Readability.js)
                         that returns the parsed article body.
options.html / .js       Pairing-token entry.
vendor/Readability.js    Mozilla Readability — auto-copied here by the
                         postinstall script. Gitignored.
scripts/vendor.mjs       Copies Readability.js out of node_modules.
```

## Permissions

- `contextMenus` — adds the right-click entry.
- `activeTab` + `scripting` — runs extraction in the current tab only when the user explicitly asks (popup click / context menu / shortcut). No `<all_urls>` host permission.
- `storage` — persists the pairing token across browser sessions (`chrome.storage.sync`).
- `host_permissions: http://127.0.0.1:38219/*` — the only host the extension fetches.

## Debugging

- Service worker logs: `chrome://extensions` → BoxTalk Reader → **Service worker → Inspect**.
- Popup logs: open the popup, right-click → **Inspect**.
- Bridge logs: stdout of the desktop app process.
