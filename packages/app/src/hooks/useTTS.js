// Audio playback orchestration for both "speak" (main playback + history) and
// "preview" (per-voice sample). The two share a single concept of "the audio
// that's playing right now" so previews stop main playback and vice-versa.
//
// Returns:
//   playing            — bool, true while main `speak()` audio is playing
//   busy               — bool, true while speak() is awaiting synthesis
//   previewingVoice    — voiceId currently previewing (or null)
//   previewLoading     — bool, preview generation in flight
//   error              — last error message (string|null), cleared on next action
//   lastEntry          — most recent history entry from speak() (for tests)
//   speak({voice,text,speed,modelId,mode,source})
//   speakSequence({voice,chunks,speed,modelId,mode,source})
//     Plays chunks back-to-back. Each chunk gets its own history entry. Stop
//     aborts the whole sequence.
//   previewVoice({voice,model})    plays a "Hi I'm <name>" sample
//   stop()                          halts whatever is playing

import { useCallback, useRef, useState } from "react";

function disposeAudio(audio, url) {
  if (audio) { audio.pause(); audio.src = ""; }
  if (url) URL.revokeObjectURL(url);
}

export function useTTS({ history }) {
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [busy, setBusy] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastEntry, setLastEntry] = useState(null);

  const mainAudio = useRef(null);
  const mainUrl = useRef(null);
  const playbackRateRef = useRef(1);
  const previewAudio = useRef(null);
  const previewUrl = useRef(null);
  // Sequence token. Bumped on stop() / new speak(), so an in-flight
  // sequence can notice it's been preempted and bail.
  const sequenceToken = useRef(0);
  // Token guards against a stale preview resolving after the user clicks Stop
  // or starts a different preview.
  const previewToken = useRef(0);

  const clearMain = useCallback(() => {
    sequenceToken.current++;
    disposeAudio(mainAudio.current, mainUrl.current);
    mainAudio.current = null;
    mainUrl.current = null;
    setPlaying(false);
    setPaused(false);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  const clearPreview = useCallback(() => {
    previewToken.current++;
    disposeAudio(previewAudio.current, previewUrl.current);
    previewAudio.current = null;
    previewUrl.current = null;
    setPreviewingVoice(null);
    setPreviewLoading(false);
  }, []);

  const stop = useCallback(() => {
    clearMain();
    clearPreview();
  }, [clearMain, clearPreview]);

  const speak = useCallback(async ({ modelId, voice, text, speed, mode, source = "Manual" }) => {
    clearMain();
    clearPreview();
    setError(null);
    setBusy(true);

    try {
      const result = await window.tts.generate({ modelId, voice, text, speed, mode });
      const blob = new Blob([result.wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      mainAudio.current = audio;
      mainUrl.current = url;

      const durationSec = result.samples ? result.samples / result.samplingRate : null;
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        voice,
        source,
        timestamp: Date.now(),
        durationSec,
        size: blob.size,
        samplingRate: result.samplingRate,
        synthMs: result.synthMs ?? 0,
      };
      await history.add(entry);
      setLastEntry(entry);

      const onDone = () => { setPlaying(false); };
      audio.onended = onDone;
      audio.onerror = onDone;

      await audio.play();
      setPlaying(true);
      return entry;
    } catch (err) {
      console.error("speak:", err);
      setError(err?.message ?? String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [clearMain, clearPreview, history]);

  const speakSequence = useCallback(async ({ modelId, voice, chunks, speed, mode, source = "Manual" }) => {
    if (!chunks || chunks.length === 0) return null;
    clearPreview();
    // clearMain bumps sequenceToken; capture AFTER clearing so this sequence
    // owns the new token value.
    clearMain();
    const myToken = ++sequenceToken.current;
    setError(null);
    setBusy(true);

    let lastChunkEntry = null;

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (myToken !== sequenceToken.current) return lastChunkEntry; // preempted
        const chunk = chunks[i];

        const result = await window.tts.generate({ modelId, voice, text: chunk, speed, mode });
        if (myToken !== sequenceToken.current) return lastChunkEntry;

        const blob = new Blob([result.wav], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        // Swap in the new chunk's audio (and dispose the previous chunk's).
        disposeAudio(mainAudio.current, mainUrl.current);
        mainAudio.current = audio;
        mainUrl.current = url;

        const durationSec = result.samples ? result.samples / result.samplingRate : null;
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: chunk,
          voice,
          source,
          timestamp: Date.now(),
          durationSec,
          size: blob.size,
          samplingRate: result.samplingRate,
          synthMs: result.synthMs ?? 0,
        };
        await history.add(entry);
        setLastEntry(entry);
        lastChunkEntry = entry;

        const ended = new Promise((resolve) => {
          audio.onended = resolve;
          audio.onerror = resolve;
        });
        // First chunk: switch out of busy as soon as audio starts.
        if (i === 0) setBusy(false);
        await audio.play();
        setPlaying(true);
        await ended;
        if (myToken !== sequenceToken.current) return lastChunkEntry;
      }
      setPlaying(false);
      return lastChunkEntry;
    } catch (err) {
      console.error("speakSequence:", err);
      setError(err?.message ?? String(err));
      return lastChunkEntry;
    } finally {
      setBusy(false);
    }
  }, [clearMain, clearPreview, history]);

  // Play a pre-rendered WAV (e.g. a digested candidate from the Queue).
  // Shares the mainAudio slot so the global Stop button still works and so
  // a new Speak preempts playback. Wires up timeupdate/loadedmetadata so the
  // Queue view can render a scrub bar with pause + seek.
  const playRaw = useCallback(async ({ wav, onEnded }) => {
    clearMain();
    clearPreview();
    setError(null);

    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = playbackRateRef.current;
    mainAudio.current = audio;
    mainUrl.current = url;

    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.ontimeupdate = () => setCurrentTime(audio.currentTime || 0);
    audio.onpause = () => {
      // Distinguish a user-driven pause from end-of-track / disposal.
      if (mainAudio.current === audio && !audio.ended) setPaused(true);
    };
    audio.onplay = () => setPaused(false);

    const onDone = () => {
      setPlaying(false);
      setPaused(false);
      setCurrentTime(0);
      onEnded?.();
    };
    audio.onended = onDone;
    audio.onerror = onDone;

    await audio.play();
    setPlaying(true);
    setPaused(false);
  }, [clearMain, clearPreview]);

  const pause = useCallback(() => {
    const a = mainAudio.current;
    if (a && !a.paused) a.pause();
  }, []);

  const resume = useCallback(() => {
    const a = mainAudio.current;
    if (a && a.paused) a.play().catch((err) => console.error("resume:", err));
  }, []);

  const seek = useCallback((seconds) => {
    const a = mainAudio.current;
    if (!a) return;
    const clamped = Math.max(0, Math.min(seconds, a.duration || seconds));
    a.currentTime = clamped;
    setCurrentTime(clamped);
  }, []);

  const setPlaybackRate = useCallback((rate) => {
    const r = Math.max(0.25, Math.min(4, Number(rate) || 1));
    playbackRateRef.current = r;
    setPlaybackRateState(r);
    const a = mainAudio.current;
    if (a) a.playbackRate = r;
  }, []);

  const previewVoiceCall = useCallback(async ({ voice, model }) => {
    clearMain();
    clearPreview();
    setError(null);

    const myToken = ++previewToken.current;
    setPreviewingVoice(voice.id);
    setPreviewLoading(true);

    try {
      const sampleText = `Hi, I'm ${voice.label}.`;
      const result = await window.tts.generate({
        modelId: model.id,
        voice: voice.id,
        text: sampleText,
      });
      if (myToken !== previewToken.current) return; // superseded

      const blob = new Blob([result.wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudio.current = audio;
      previewUrl.current = url;
      setPreviewLoading(false);

      const cleanup = () => {
        if (myToken === previewToken.current) clearPreview();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;

      // Don't await play() — it rejects with AbortError if the user pauses
      // before it resolves, which is normal.
      audio.play().catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("preview play:", err);
        cleanup();
      });
    } catch (err) {
      console.error("preview:", err);
      setError(`Preview failed: ${err?.message ?? String(err)}`);
      if (myToken === previewToken.current) clearPreview();
    }
  }, [clearMain, clearPreview]);

  return {
    playing,
    paused,
    currentTime,
    duration,
    playbackRate,
    busy,
    previewingVoice,
    previewLoading,
    error,
    lastEntry,
    speak,
    speakSequence,
    playRaw,
    previewVoice: previewVoiceCall,
    pause,
    resume,
    seek,
    setPlaybackRate,
    stop,
    setError, // for callers to clear
  };
}
