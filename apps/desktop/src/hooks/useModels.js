// Tracks per-model load state. Subscribes to window.models events from preload,
// returns { states, load, runMode, setRunMode } where:
//   states[modelId] = { state: "idle"|"loading"|"ready"|"error", error, progress }
//   load(modelId)     triggers a load via IPC; errors surface as state="error"
//   runMode[modelId]  = currently-selected run-mode id
//   setRunMode(id,mode) updates run mode (UI-only state, sent on generate)

import { useEffect, useReducer, useCallback, useState } from "react";
import { MODELS, defaultRunMode } from "../data/models.js";

function initialStates() {
  return Object.fromEntries(
    MODELS.map((m) => [m.id, { state: "idle", error: null, progress: null }]),
  );
}

function initialRunModes() {
  return Object.fromEntries(MODELS.map((m) => [m.id, defaultRunMode(m)]));
}

function statesReducer(prev, action) {
  switch (action.type) {
    case "state": {
      const cur = prev[action.modelId] ?? { state: "idle", error: null, progress: null };
      const next = {
        ...cur,
        state: action.state,
        error: action.error ?? null,
        // Clear progress on terminal states so a re-load shows a fresh bar.
        progress: action.state === "ready" || action.state === "idle" ? null : cur.progress,
      };
      return { ...prev, [action.modelId]: next };
    }
    case "progress": {
      const cur = prev[action.modelId] ?? { state: "idle", error: null, progress: null };
      return { ...prev, [action.modelId]: { ...cur, progress: action.progress } };
    }
    case "hydrate": {
      const merged = { ...prev };
      for (const [id, s] of Object.entries(action.states)) {
        if (!merged[id]) continue;
        merged[id] = { ...merged[id], state: s.state, error: s.error ?? null };
      }
      return merged;
    }
    default:
      return prev;
  }
}

export function useModels() {
  const [states, dispatch] = useReducer(statesReducer, undefined, initialStates);
  const [runModes, setRunModes] = useState(initialRunModes);

  // Hydrate run modes from the SQLite settings table (one row per model).
  useEffect(() => {
    let cancelled = false;
    if (!window.store?.getSetting) return;
    Promise.all(
      MODELS.map((m) =>
        window.store.getSetting(`runMode.${m.id}`).then((raw) => [m.id, raw]),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const hydrated = {};
      for (const [id, raw] of entries) {
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === "string") hydrated[id] = parsed;
        } catch { /* malformed — ignore */ }
      }
      if (Object.keys(hydrated).length) {
        setRunModes((prev) => ({ ...prev, ...hydrated }));
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const offState = window.models.onState(({ modelId, state, error }) => {
      dispatch({ type: "state", modelId, state, error });
    });
    const offProgress = window.models.onProgress(({ modelId, ...progress }) => {
      dispatch({ type: "progress", modelId, progress });
    });
    window.models.states().then((initial) => {
      dispatch({ type: "hydrate", states: initial });
    });
    return () => { offState(); offProgress(); };
  }, []);

  const load = useCallback(async (modelId) => {
    try {
      await window.models.load(modelId);
    } catch (err) {
      // The main process also pushes a state="error" event, but in case the
      // IPC itself rejects (e.g. unknown id), reflect it locally too.
      dispatch({ type: "state", modelId, state: "error", error: err?.message ?? String(err) });
    }
  }, []);

  const setRunMode = useCallback((modelId, mode) => {
    setRunModes((prev) => ({ ...prev, [modelId]: mode }));
    window.store?.setSetting?.(`runMode.${modelId}`, JSON.stringify(mode))
      .catch((err) => console.error("persist runMode:", err));
  }, []);

  return { states, runModes, load, setRunMode };
}
