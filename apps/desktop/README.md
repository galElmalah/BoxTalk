# @boxtalk/app

Electron shell + React renderer for BoxTalk. This package holds the TTS engines, the SQLite history store, and the loopback HTTP bridge the Chrome extension talks to.

## UI

Sidebar-driven settings layout:

- **Speak** — text input + voice/speed display + Speak/Stop. The primary flow.
- **General** — selected model, max-history setting, and the pairing token for the Chrome extension.
- **Model** — Kokoro 82M card with live load status + grid of selectable voices.
- **History** — every synthesis recorded with text, voice, source, timestamp, duration. Live search + clear.

Color scheme: near-white gray bg, black text, pink for hover/active/toggles/app name. Bricolage Grotesque for the wordmark, Inter for body.

## How it works

- `main.js` — Electron shell + IPC + loopback HTTP bridge (`127.0.0.1:38219`) for the Chrome extension.
- `preload.js` — context-isolated bridge exposing `window.tts`, `window.models`, `window.store`, `window.bridge`.
- `src/` — React renderer (Vite). Views: Speak, General, Model, History.
- `src/lib/chunkText.js` — sentence-boundary splitter for remote-speak inputs that exceed Kokoro's comfortable single-call budget.
- `vibevoice.js` — sidecar wrapper for Microsoft VibeVoice (optional; requires `pnpm build:vibevoice`).

## Bridge protocol

All endpoints listen on `http://127.0.0.1:38219`. Mutation endpoints require `X-BoxTalk-Token: <pairing-token>` (surfaced in the app's **General → Browser extension** card).

- `GET /status` — unauthenticated. Returns `{ ok, kokoro }` so the extension popup can show its connection dot.
- `POST /speak` — body `{ text, source?, voice? }`. Brings the window to front, broadcasts a `remote:speak` IPC event to the renderer, which chunks the text via `chunkText()` and plays it sequentially. Each chunk lands as its own history entry tagged with `source` (e.g. `"news.ycombinator.com · page"`).
- `POST /candidates` — body `{ text, source?, sourceUrl?, title? }`. Inserts a row into the `candidates` SQLite table with status `pending` and broadcasts `candidates:changed`. The renderer's **Queue** view shows two columns:
  - **Waiting** — `pending` or `digesting` rows. Clicking *Digest* triggers `candidates:digest`, which chunks the text, synthesizes each chunk, merges the Float32 samples into a single 16-bit PCM WAV, and writes it to `userData/digests/<id>.wav`. Progress updates stream via `candidates:progress`.
  - **Digested** — rows with status `digested`. Clicking *Play* loads the merged WAV via `candidates:getAudio` and plays it. Source URL is shown as a clickable link; the full text can be expanded inline.

  Either column lets you dismiss a candidate (also wipes its audio file).

## Tests

```bash
pnpm smoke          # all 13 voices generate a WAV
pnpm e2e            # full user flow via Playwright + Electron
pnpm test           # smoke + e2e
```

## Voices

13 English voices (American/British, female/male) — see `src/data/models.js`. To add the full set, copy from the [kokoro-js voice list](https://github.com/hexgrad/kokoro/tree/main/kokoro.js#voices).
