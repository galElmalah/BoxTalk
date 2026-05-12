import { useCallback, useEffect, useMemo, useState } from "react";
import { MODELS, modelByVoiceId, voiceById, defaultVoiceId } from "./data/models.js";
import { useModels } from "./hooks/useModels.js";
import { useHistory } from "./hooks/useHistory.js";
import { useTTS } from "./hooks/useTTS.js";
import { useQueue } from "./hooks/useQueue.js";
import { usePersistedState } from "./hooks/usePersistedState.js";
import { chunkText } from "./lib/chunkText.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { SpeakView } from "./components/SpeakView.jsx";
import { GeneralView } from "./components/GeneralView.jsx";
import { ModelView } from "./components/ModelView.jsx";
import { HistoryView } from "./components/HistoryView.jsx";
import { QueueView } from "./components/QueueView.jsx";

const VALID_VIEWS = new Set(["speak", "queue", "general", "model", "history"]);

export function App() {
  const [view, setViewRaw] = usePersistedState("ui.view", "queue");
  const [selectedVoiceId, setSelectedVoiceId] = useState(defaultVoiceId());
  // Expanded model cards persist as a sorted string array; converted to a Set
  // for component use and back to array for persistence.
  const [expandedList, setExpandedList] = usePersistedState("ui.expandedModels", [MODELS[0].id]);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);

  // Guard against stale view ids ending up in the DB (renamed/removed views).
  const setView = useCallback((next) => {
    setViewRaw(VALID_VIEWS.has(next) ? next : "queue");
  }, [setViewRaw]);

  const models = useModels();
  const history = useHistory();
  const queue = useQueue();
  const tts = useTTS({ history });

  // Hydrate selected voice from SQLite once.
  useEffect(() => {
    let cancelled = false;
    window.store.getSelectedVoice().then((saved) => {
      if (cancelled) return;
      if (saved && voiceById(saved)) {
        setSelectedVoiceId(saved);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const selectedVoice = voiceById(selectedVoiceId);
  const selectedModel = modelByVoiceId(selectedVoiceId);
  const selectedModelState = selectedModel ? models.states[selectedModel.id] : null;
  const speakReady = selectedModelState?.state === "ready";

  const toggleExpand = useCallback((id) => {
    setExpandedList((prev) => {
      const set = new Set(prev);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  }, [setExpandedList]);

  const selectVoice = useCallback((id) => {
    if (!voiceById(id)) return;
    setSelectedVoiceId(id);
    window.store.setSelectedVoice(id).catch((err) => console.error("setSelectedVoice:", err));
  }, []);

  const togglePreview = useCallback((voice, model) => {
    if (tts.previewingVoice === voice.id) {
      tts.stop();
      return;
    }
    if (models.states[model.id]?.state !== "ready") return;
    tts.previewVoice({ voice, model });
  }, [tts, models.states]);

  const speak = useCallback(({ text, speed }) => {
    if (!selectedModel || !text) return;
    return tts.speak({
      modelId: selectedModel.id,
      voice: selectedVoiceId,
      text,
      speed,
      mode: models.runModes[selectedModel.id],
    });
  }, [tts, selectedModel, selectedVoiceId, models.runModes]);

  const [playingDigestId, setPlayingDigestId] = useState(null);

  // Clear playing-digest indicator any time another playback (speak, preview,
  // explicit stop) takes the audio slot.
  useEffect(() => {
    if (!tts.playing && playingDigestId) setPlayingDigestId(null);
  }, [tts.playing, playingDigestId]);

  // Kick off background digestion for a queued candidate. The voice is the
  // one selected in the Queue toolbar (falls back to the app-wide default).
  // Digest always synthesizes at 1.0× — playback speed is a live setting on
  // the digested audio, not a render-time parameter.
  const digestCandidate = useCallback((id, opts = {}) => {
    const voice = opts.voice || selectedVoiceId;
    return queue.digest(id, voice);
  }, [queue, selectedVoiceId]);

  // Play a digested candidate. Click-toggle: if it's already playing, stop.
  const playDigested = useCallback(async (item) => {
    if (item.status !== "digested") return;
    if (playingDigestId === item.id) {
      tts.stop();
      setPlayingDigestId(null);
      return;
    }
    try {
      const audio = await window.queue.getAudio(item.id);
      setPlayingDigestId(item.id);
      await tts.playRaw({
        wav: audio.wav,
        onEnded: () => setPlayingDigestId(null),
      });
    } catch (err) {
      console.error("playDigested:", err);
      setPlayingDigestId(null);
      tts.setError(err.message || String(err));
    }
  }, [tts, playingDigestId]);

  // Chrome extension → main process → here. Resolve the voice (fall back to
  // current selection if the payload didn't specify one or specified an
  // unknown one), chunk long text, and play through speakSequence.
  useEffect(() => {
    if (!window.bridge) return;
    return window.bridge.onSpeak(({ text, source, voice }) => {
      const voiceId = voice && voiceById(voice) ? voice : selectedVoiceId;
      const model = modelByVoiceId(voiceId);
      if (!model) return;
      const state = models.states[model.id];
      if (state?.state !== "ready") {
        tts.setError(`${model.label} not loaded — open the Model tab and load it before sending text.`);
        return;
      }
      const chunks = chunkText(text);
      if (chunks.length === 0) return;
      tts.speakSequence({
        modelId: model.id,
        voice: voiceId,
        chunks,
        mode: models.runModes[model.id],
        source: source || "Extension",
      });
    });
  }, [tts, selectedVoiceId, models.states, models.runModes]);

  // ─── Test hooks (window.__tts) ──────────────────────────────────────
  // Smoke + e2e tests read these. We mirror reactive state on every render
  // so the hooks stay in sync without needing a tap-into-React pattern.
  useEffect(() => {
    const kokoroState = models.states.kokoro;
    window.__tts = {
      ...(window.__tts || {}),
      ready: kokoroState?.state === "ready",
      busy: tts.busy,
      loadError: kokoroState?.state === "error" ? kokoroState.error : null,
      voices: MODELS[0].voices,
      models: MODELS,
      modelStates: JSON.parse(JSON.stringify(models.states)),
      playbackState: tts.playing
        ? { playing: true, voice: selectedVoiceId }
        : { playing: false },
      previewState: tts.previewingVoice
        ? { playing: !tts.previewLoading, voice: tts.previewingVoice, loading: tts.previewLoading }
        : { playing: false, voice: null },
      lastEvent: tts.lastEntry,
      async generate(voice, text) {
        const m = modelByVoiceId(voice);
        if (!m) throw new Error("unknown voice: " + voice);
        if (models.states[m.id].state !== "ready") throw new Error(m.id + " not loaded");
        const result = await window.tts.generate({ modelId: m.id, voice, text });
        return {
          voice,
          size: result.wav.byteLength,
          samplingRate: result.samplingRate,
          durationSec: result.samples ? result.samples / result.samplingRate : null,
          synthMs: result.synthMs,
        };
      },
      getHistory: () => history.items.slice(),
      getSelectedVoice: () => selectedVoiceId,
    };
  });

  return (
    <div className="app">
      <Sidebar view={view} onNavigate={setView} queueCount={queue.items.length} />
      <main className="content">
        <SpeakView
          active={view === "speak"}
          voice={selectedVoice}
          model={selectedModel}
          modelReady={speakReady}
          busy={tts.busy}
          playing={tts.playing}
          error={tts.error}
          onSpeak={speak}
          onStop={tts.stop}
        />
        <GeneralView
          active={view === "general"}
          modelLabel={selectedModel?.label ?? "—"}
          maxHistory={history.maxHistory}
          onSetMaxHistory={history.setMaxHistory}
        />
        <ModelView
          active={view === "model"}
          modelStates={models.states}
          runModes={models.runModes}
          expanded={expanded}
          selectedVoiceId={selectedVoiceId}
          previewingVoice={tts.previewingVoice}
          previewLoading={tts.previewLoading}
          onToggleExpand={toggleExpand}
          onLoad={models.load}
          onSetRunMode={models.setRunMode}
          onSelectVoice={selectVoice}
          onTogglePreview={togglePreview}
        />
        <HistoryView
          active={view === "history"}
          items={history.items}
          onClear={history.clear}
        />
        <QueueView
          active={view === "queue"}
          items={queue.items}
          progress={queue.progress}
          playingId={playingDigestId}
          paused={tts.paused}
          currentTime={tts.currentTime}
          duration={tts.duration}
          playbackRate={tts.playbackRate}
          defaultVoiceId={selectedVoiceId}
          onDigest={digestCandidate}
          onCancel={queue.cancel}
          onPlay={playDigested}
          onPause={tts.pause}
          onResume={tts.resume}
          onSeek={tts.seek}
          onPlaybackRateChange={tts.setPlaybackRate}
          onDismiss={queue.remove}
          onClear={queue.clear}
        />
      </main>
    </div>
  );
}
