# BoxTalk

Local text-to-speech on your desktop, paired with a Chrome extension that pipes any web page (or selected text) to it. Powered by [Kokoro](https://github.com/hexgrad/kokoro) — an 82M-parameter open-weights TTS model — running entirely on your machine via `onnxruntime-node`. No cloud round-trip, no API key, no telemetry. English only for now; the model supports other languages and they're on the roadmap.

![Queue view](docs/screenshots/queue.png)

## Why

Most "read this article aloud" tools either ship audio to a cloud API or use the OS's built-in voices. BoxTalk does neither: it runs Kokoro locally so your reading list never leaves your laptop, and the voices are dramatically better than `say` / SAPI / espeak. The Chrome extension is the glue — you keep browsing, you queue or speak from the page you're on, and BoxTalk handles synthesis, playback, and history.

## Two pieces

```
┌──────────────────────────┐                    ┌───────────────────────────┐
│  Chrome extension (MV3)  │  HTTP + token      │   BoxTalk desktop app     │
│  • right-click selection │ ─────────────────▶ │   • Kokoro TTS engine     │
│  • whole-page popup      │  127.0.0.1:38219   │   • Queue + History       │
│  • Cmd/Ctrl+Shift+S      │                    │   • Local SQLite store    │
└──────────────────────────┘                    └───────────────────────────┘
```

Both halves are in this monorepo:

```
packages/
  app/         Electron + React desktop app (TTS engine + UI)
  extension/   MV3 Chrome extension (selection / page → desktop bridge)
```

## Install

### 1. Get the desktop app

**Pre-built release (recommended)** — grab the latest DMG from the [Releases](../../releases) page, drag BoxTalk.app into Applications, and launch it. First launch downloads the quantized Kokoro model (~80 MB) from Hugging Face; every launch after that runs offline.

**From source** — if you want to hack on the app or there's no release for your platform yet:

```bash
pnpm install
pnpm start        # builds the renderer and launches Electron
```

You'll need Node 20+ and [pnpm](https://pnpm.io/). To produce a distributable DMG:

```bash
pnpm dist:mac     # writes packages/app/release/*.dmg
```

### 2. Load the Chrome extension

The extension isn't on the Chrome Web Store yet — load it as an unpacked extension:

1. Open `chrome://extensions` and toggle **Developer mode** on.
2. Click **Load unpacked** and pick `packages/extension/` from this repo.
3. In the BoxTalk app, open **General → Browser extension** and copy the pairing token.
4. Click the extension's toolbar icon → **Settings** → paste the token → **Save**.

The popup's status dot should turn green when it can reach the desktop app.

## How the two halves talk

The desktop app runs a minimal HTTP server on `http://127.0.0.1:38219` — loopback only, never bound to a public interface. Every mutating request must carry an `X-BoxTalk-Token: <pairing-token>` header. The token is a 24-byte random string generated on first launch and stored in the app's local SQLite database. It surfaces in **General → Browser extension** so you can paste it into the extension's settings page.

The bridge exposes three endpoints:

| Endpoint           | Auth   | What it does                                                                                |
| ------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `GET  /status`     | none   | Health check. Returns `{ ok, kokoro }` so the extension can render its connection dot.       |
| `POST /speak`      | token  | "Read this now." The app focuses, chunks the text sentence-by-sentence, and plays it.        |
| `POST /candidates` | token  | "Save this for later." Inserts a row into the Queue (Waiting column). The app stays quiet.   |

The extension never opens an arbitrary host. Its only host permission is `http://127.0.0.1:38219/*`. Without the desktop app running on loopback nothing happens — there's no fallback path.

![General view with pairing token](docs/screenshots/general.png)

## Using the extension

There are two modes and two actions, which cross-multiply to four flows. All of them post text from the active tab to the desktop app.

- **Selection** — highlight text on any page, then either right-click → "Speak with BoxTalk", press `Cmd/Ctrl+Shift+S`, or open the popup's *Selection* tab.
- **Whole page** — open the popup's *Whole page* tab. The extension runs Mozilla [Readability](https://github.com/mozilla/readability) on a clone of the live DOM (same algorithm as Firefox Reader View) and shows the article body so you can edit or trim before sending.

For each mode you can choose:

- **Speak now** → `/speak`. The desktop app jumps to the front and starts reading.
- **Save for later** → `/candidates`. Lands silently in the Queue with the source URL and page title.

Long pages are chunked by the desktop app and played back-to-back — each chunk is also written to the History tab tagged with the source URL.

## The Queue

![Queue view](docs/screenshots/queue.png)

The Queue is the first thing you see when you open BoxTalk, because it's where saved-for-later pages land. Pick the **voice** and **speed** at the top of the page — those settings apply when you press *Digest*. Digesting pre-renders the whole article to a single WAV under the app's user-data dir (`userData/digests/<id>.wav`), so playback is instant and works without the model loaded.

Once digested, a card moves to the right-hand *Digested* column. Click *Play* and you get full transport controls: **pause/resume**, plus a **seek slider with a hover tooltip** that shows the minute-and-second you'd jump to. Stop returns the card to its idle state.

## The other views

| View          | What it does                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Queue**     | Pages + selections from the extension. Pick voice/speed at the top, *Digest* to render, *Play* with pause + seek.       |
| **General**   | App-level settings: selected model, history retention, and the pairing token.                                            |
| **Model**     | Live model status. Kokoro 82M loads automatically on first launch (~80 MB download, then cached).                        |
| **History**   | Every synthesis recorded, with text, voice, source, timestamp, duration. Live search + clear.                            |
| **Speak**     | Free-form text input. Type, pick speed, hit Speak.                                                                       |

![Model view](docs/screenshots/model.png)

![Speak view](docs/screenshots/speak.png)

## Voices

13 English Kokoro voices ship in the box — American + British, female + male. They're all listed in the **Model** card; click the play button on any row to preview the voice, and the radio dot to make it the default.

## Tests

```bash
pnpm smoke    # all 13 voices generate a WAV
pnpm e2e      # full UI flow via Playwright + Electron
pnpm test     # smoke + e2e
```

See `packages/app/README.md` for what each test covers, and `packages/extension/README.md` for loading + debugging the extension.

## Roadmap

- [x] Chrome extension that captures selected text / page content and pipes it to this app.
- [x] Queue view with voice + speed selectors and digest-then-listen workflow.
- [x] Seek + pause controls for digested audio.
- [ ] More languages — Kokoro supports Japanese, Mandarin, Spanish, French, Hindi, Italian, Portuguese.
- [ ] Optional second engine (e.g. Microsoft VibeVoice) — requires Python sidecar, deferred.
- [ ] "Summarize then read" mode driven by a local LLM in the extension.

## License

MIT.
