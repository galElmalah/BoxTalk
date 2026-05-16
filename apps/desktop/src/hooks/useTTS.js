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
//     Plays pre-chunked text back-to-back via gapless WebAudio. Each chunk
//     gets its own history entry. Used for non-streaming backends (e.g.
//     VibeVoice). For Kokoro, prefer speakStream — kokoro's tokenizer
//     silently truncates inputs beyond ~600 chars (Node bench proved it),
//     so chunking ourselves loses content. Stop aborts the whole sequence.
//   speakStream({voice,text,speed,modelId,mode,source})
//     Streams kokoro audio per-sentence using the worker's `tts:stream`
//     IPC channel. Each segment is scheduled sample-accurately via
//     WebAudio for gapless playback. Returns one history entry for the
//     whole utterance. TTFA ~3s vs ~9s for chunked.
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
  // Active gapless sequence (WebAudio). Created by speakSequence, torn down
  // by clearMain. Holds the AudioContext + every scheduled BufferSource so
  // stop() can silence them sample-accurately.
  const sequence = useRef(null);
  // Sequence token. Bumped on stop() / new speak(), so an in-flight
  // sequence can notice it's been preempted and bail.
  const sequenceToken = useRef(0);
  // Token guards against a stale preview resolving after the user clicks Stop
  // or starts a different preview.
  const previewToken = useRef(0);

  const disposeSequence = useCallback(() => {
    const seq = sequence.current;
    if (!seq) return;
    sequence.current = null;
    seq.canceled = true;
    for (const s of seq.sources) {
      try { s.onended = null; s.stop(); s.disconnect(); } catch {}
    }
    try { seq.audioCtx.close(); } catch {}
  }, []);

  const clearMain = useCallback(() => {
    sequenceToken.current++;
    disposeAudio(mainAudio.current, mainUrl.current);
    mainAudio.current = null;
    mainUrl.current = null;
    disposeSequence();
    setPlaying(false);
    setPaused(false);
    setCurrentTime(0);
    setDuration(0);
  }, [disposeSequence]);

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

  // Play a list of chunks as one continuous, gapless utterance.
  //
  // Strategy:
  //   1. Pipeline synthesis. Synth requests are chained so the kokoro
  //      worker (single-threaded) handles them one at a time, but later
  //      chunks start synthesizing while earlier chunks are still playing.
  //      Since synthesis on Kokoro runs at ~0.34× real-time, every chunk
  //      after the first finishes synthesizing well before its slot.
  //   2. Schedule playback with WebAudio. Each chunk's decoded AudioBuffer
  //      is played via an AudioBufferSourceNode started at the exact
  //      AudioContext time the previous chunk ends — no inter-chunk gap,
  //      no boundary click from swapping <audio> elements.
  //   3. Retry once on worker crash. The kokoro-js + onnxruntime + phonemizer
  //      pipeline trips a native trap intermittently; the worker auto-
  //      respawns and the second attempt succeeds (mirrors digestCandidate
  //      in main.js).
  const speakSequence = useCallback(async ({ modelId, voice, chunks, speed, mode, source = "Manual" }) => {
    if (!chunks || chunks.length === 0) return null;
    clearPreview();
    // clearMain bumps sequenceToken and tears down any previous sequence.
    clearMain();
    const myToken = ++sequenceToken.current;
    setError(null);
    setBusy(true);

    const Ctor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new Ctor();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    const seq = { audioCtx, sources: [], canceled: false };
    sequence.current = seq;

    const generateWithRetry = async (text) => {
      try {
        return await window.tts.generate({ modelId, voice, text, speed, mode });
      } catch (err) {
        if (myToken !== sequenceToken.current) throw err;
        if (!/worker crashed/i.test(err?.message ?? "")) throw err;
        console.warn("speakSequence: kokoro worker crashed; retrying once");
        return window.tts.generate({ modelId, voice, text, speed, mode });
      }
    };

    // Chain synth requests so the worker handles them serially.
    let chain = Promise.resolve();
    const synthQueue = chunks.map((chunk) => {
      const p = chain.then(() => {
        if (myToken !== sequenceToken.current) {
          const e = new Error("preempted");
          e.preempted = true;
          throw e;
        }
        return generateWithRetry(chunk);
      });
      chain = p.catch(() => undefined); // keep chaining even after errors
      return p;
    });

    let scheduleTime = null;
    let lastChunkEntry = null;

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (seq.canceled || myToken !== sequenceToken.current) return lastChunkEntry;
        const result = await synthQueue[i];
        if (seq.canceled || myToken !== sequenceToken.current) return lastChunkEntry;

        const u8 = result.wav instanceof Uint8Array ? result.wav : new Uint8Array(result.wav);
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        const audioBuffer = await audioCtx.decodeAudioData(ab);
        if (seq.canceled || myToken !== sequenceToken.current) return lastChunkEntry;

        if (scheduleTime === null) {
          // First chunk: schedule a hair in the future so the source node is
          // wired up before its start deadline.
          scheduleTime = audioCtx.currentTime + 0.05;
        }
        // If synth slipped behind playback, the ideal start is in the past.
        // Clamp to currentTime — there'll be a brief gap but the alternative
        // is dropping the chunk entirely.
        const startAt = Math.max(scheduleTime, audioCtx.currentTime);

        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.playbackRate.value = playbackRateRef.current;
        src.connect(audioCtx.destination);
        src.start(startAt);
        seq.sources.push(src);
        scheduleTime = startAt + audioBuffer.duration;

        const durationSec = audioBuffer.duration;
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: chunks[i],
          voice,
          source,
          timestamp: Date.now(),
          durationSec,
          size: u8.byteLength,
          samplingRate: result.samplingRate,
          synthMs: result.synthMs ?? 0,
        };
        await history.add(entry);
        setLastEntry(entry);
        lastChunkEntry = entry;

        if (i === 0) {
          setBusy(false);
          setPlaying(true);
        }
      }

      // Wait for the last scheduled source to actually finish playing.
      const last = seq.sources.at(-1);
      if (last && !seq.canceled) {
        await new Promise((resolve) => {
          last.onended = resolve;
        });
      }
      if (myToken === sequenceToken.current) {
        setPlaying(false);
        disposeSequence();
      }
      return lastChunkEntry;
    } catch (err) {
      if (err?.preempted) return lastChunkEntry;
      console.error("speakSequence:", err);
      setError(err?.message ?? String(err));
      return lastChunkEntry;
    } finally {
      setBusy(false);
    }
  }, [clearMain, clearPreview, disposeSequence, history]);

  // Streaming utterance — preferred path for kokoro because the model
  // tokenizer silently truncates inputs beyond ~600 chars (Node bench
  // proved this), so chunking ourselves was losing ~20% of long inputs.
  //
  // The worker uses kokoro-js' `tts.stream()` to yield per-sentence audio.
  // Each segment is shipped back as a WAV; we decode it with WebAudio and
  // schedule it sample-accurately at the previous segment's end, same as
  // speakSequence — no gaps, no boundary clicks. The synth pipeline runs
  // in the worker in the background; the renderer just queues segments as
  // they arrive.
  //
  // History: one entry per utterance (with full text + total duration),
  // recorded after the stream ends — per-sentence entries would spam the
  // History view.
  const speakStream = useCallback(async ({ modelId = "kokoro", voice, text, speed, mode, source = "Manual" }) => {
    if (!text || typeof text !== "string") return null;
    clearPreview();
    clearMain();
    const myToken = ++sequenceToken.current;
    setError(null);
    setBusy(true);

    const Ctor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new Ctor();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    const seq = { audioCtx, sources: [], canceled: false };
    sequence.current = seq;

    let scheduleTime = null;
    let totalAudioDur = 0;
    let firstSegmentAt = null;
    const t0 = performance.now();

    const handle = window.tts.stream({
      modelId,
      voice,
      text,
      speed,
      mode,
      onSegment: async ({ wav, samplingRate, samples }) => {
        if (seq.canceled || myToken !== sequenceToken.current) return;
        try {
          const u8 = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          const audioBuffer = await audioCtx.decodeAudioData(ab);
          if (seq.canceled || myToken !== sequenceToken.current) return;

          if (scheduleTime === null) {
            scheduleTime = audioCtx.currentTime + 0.05;
          }
          const startAt = Math.max(scheduleTime, audioCtx.currentTime);
          const src = audioCtx.createBufferSource();
          src.buffer = audioBuffer;
          src.playbackRate.value = playbackRateRef.current;
          src.connect(audioCtx.destination);
          src.start(startAt);
          seq.sources.push(src);
          scheduleTime = startAt + audioBuffer.duration;
          totalAudioDur += audioBuffer.duration;

          if (firstSegmentAt === null) {
            firstSegmentAt = performance.now() - t0;
            setBusy(false);
            setPlaying(true);
          }
        } catch (err) {
          console.error("speakStream segment:", err);
        }
      },
    });

    try {
      const info = await handle.done;
      if (seq.canceled || myToken !== sequenceToken.current) return null;

      // Wait for the last scheduled source to finish playing.
      const last = seq.sources.at(-1);
      if (last) {
        await new Promise((resolve) => { last.onended = resolve; });
      }
      if (myToken === sequenceToken.current) {
        setPlaying(false);
        disposeSequence();
      }

      // One history entry for the whole utterance.
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        voice,
        source,
        timestamp: Date.now(),
        durationSec: totalAudioDur,
        size: 0, // not tracked across segments — would require summing
        samplingRate: 24000,
        synthMs: info?.totalSynthMs ?? 0,
      };
      await history.add(entry);
      setLastEntry(entry);
      return entry;
    } catch (err) {
      console.error("speakStream:", err);
      setError(err?.message ?? String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [clearMain, clearPreview, disposeSequence, history]);

  // Play a pre-rendered WAV (e.g. a digested candidate from the Queue).
  // Shares the mainAudio slot so the global Stop button still works and so
  // a new Speak preempts playback. Wires up timeupdate/loadedmetadata so the
  // Queue view can render a scrub bar with pause + seek.
  //
  // We deliberately do NOT call clearMain() here: clearMain flips setPlaying
  // to false, and downstream consumers that key on (tts.playing, externalId)
  // — e.g. App.jsx's playingDigestId cleanup effect — would clear their
  // bookkeeping during the brief window before audio.play() resolves. We
  // dispose the previous audio in place and only flip setPlaying once the
  // new audio is actually started.
  const playRaw = useCallback(async ({ wav, onEnded }) => {
    sequenceToken.current++;
    disposeAudio(mainAudio.current, mainUrl.current);
    mainAudio.current = null;
    mainUrl.current = null;
    setPaused(false);
    setCurrentTime(0);
    setDuration(0);
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
    if (a && !a.paused) { a.pause(); return; }
    // No HTMLAudio active — try suspending the active WebAudio sequence.
    const seq = sequence.current;
    if (seq && seq.audioCtx.state === "running") {
      seq.audioCtx.suspend().then(() => setPaused(true)).catch(() => {});
    }
  }, []);

  const resume = useCallback(() => {
    const a = mainAudio.current;
    if (a && a.paused) { a.play().catch((err) => console.error("resume:", err)); return; }
    const seq = sequence.current;
    if (seq && seq.audioCtx.state === "suspended") {
      seq.audioCtx.resume().then(() => setPaused(false)).catch(() => {});
    }
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
    // Update any currently-queued sequence sources too. Existing sources
    // change rate mid-flight; sources scheduled after this point pick it
    // up at construction.
    const seq = sequence.current;
    if (seq) {
      for (const s of seq.sources) {
        try { s.playbackRate.value = r; } catch {}
      }
    }
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
    speakStream,
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
