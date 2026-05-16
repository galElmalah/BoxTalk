const { contextBridge, ipcRenderer } = require("electron");

function subscribable(channel) {
  const set = new Set();
  ipcRenderer.on(channel, (_e, payload) => {
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  });
  return (fn) => { set.add(fn); return () => set.delete(fn); };
}

contextBridge.exposeInMainWorld("tts", {
  generate: (args) => ipcRenderer.invoke("tts:generate", args),

  // Per-sentence streaming. The renderer hands in callbacks; preload wires
  // them to the main-process events for this specific clientId so multiple
  // callers (or rapid Speak/Stop cycles) don't cross-talk.
  //
  // Returns { cancel(): Promise<void>, done: Promise<{segmentCount,totalSynthMs,canceled}> }.
  stream: ({ modelId, voice, text, speed, mode, onSegment, onEnd, onError } = {}) => {
    const clientId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let donePromiseResolve, donePromiseReject;
    const done = new Promise((resolve, reject) => {
      donePromiseResolve = resolve;
      donePromiseReject = reject;
    });

    const offSegment = (_e, payload) => {
      if (!payload || payload.clientId !== clientId) return;
      try { onSegment?.(payload); } catch (err) { console.error("[tts.stream] onSegment:", err); }
    };
    const offEnd = (_e, payload) => {
      if (!payload || payload.clientId !== clientId) return;
      cleanup();
      try { onEnd?.(payload); } catch (err) { console.error("[tts.stream] onEnd:", err); }
      donePromiseResolve(payload);
    };
    const offError = (_e, payload) => {
      if (!payload || payload.clientId !== clientId) return;
      cleanup();
      const err = new Error(payload.message || "tts stream error");
      try { onError?.(err); } catch (e) { console.error("[tts.stream] onError:", e); }
      donePromiseReject(err);
    };
    function cleanup() {
      ipcRenderer.off("tts:streamSegment", offSegment);
      ipcRenderer.off("tts:streamEnd", offEnd);
      ipcRenderer.off("tts:streamError", offError);
    }
    ipcRenderer.on("tts:streamSegment", offSegment);
    ipcRenderer.on("tts:streamEnd", offEnd);
    ipcRenderer.on("tts:streamError", offError);

    const startPromise = ipcRenderer.invoke("tts:streamStart", {
      clientId, modelId, voice, text, speed, mode,
    }).catch((err) => {
      cleanup();
      donePromiseReject(err);
    });

    return {
      clientId,
      done,
      cancel: async () => {
        try { await ipcRenderer.invoke("tts:streamCancel", { clientId }); } catch {}
      },
      // Internal: surface the start invoke so callers that want to know
      // when the worker accepted the stream can await it.
      started: startPromise,
    };
  },
});

contextBridge.exposeInMainWorld("models", {
  states: () => ipcRenderer.invoke("models:states"),
  load: (id) => ipcRenderer.invoke("models:load", id),
  onState: subscribable("models:state"),
  onProgress: subscribable("models:progress"),
});

// SQLite-backed persistence in the main process. window.history is reserved
// by the browser, so we expose this as window.store.
contextBridge.exposeInMainWorld("store", {
  listHistory:      ()        => ipcRenderer.invoke("store:listHistory"),
  addHistory:       (entry)   => ipcRenderer.invoke("store:addHistory", entry),
  clearHistory:     ()        => ipcRenderer.invoke("store:clearHistory"),
  getMaxHistory:    ()        => ipcRenderer.invoke("store:getMaxHistory"),
  setMaxHistory:    (n)       => ipcRenderer.invoke("store:setMaxHistory", n),
  getSelectedVoice: ()        => ipcRenderer.invoke("store:getSelectedVoice"),
  setSelectedVoice: (v)       => ipcRenderer.invoke("store:setSelectedVoice", v),
  getSetting:       (k)       => ipcRenderer.invoke("store:getSetting", k),
  setSetting:       (k, v)    => ipcRenderer.invoke("store:setSetting", k, v),
  deleteSetting:    (k)       => ipcRenderer.invoke("store:deleteSetting", k),
});

contextBridge.exposeInMainWorld("bridge", {
  getToken: () => ipcRenderer.invoke("bridge:getToken"),
  onSpeak: subscribable("remote:speak"),
});

contextBridge.exposeInMainWorld("queue", {
  list:     ()             => ipcRenderer.invoke("candidates:list"),
  delete:   (id)           => ipcRenderer.invoke("candidates:delete", id),
  clear:    ()             => ipcRenderer.invoke("candidates:clear"),
  digest:   (id, voice)        => ipcRenderer.invoke("candidates:digest", { id, voice }),
  cancel:   (id)           => ipcRenderer.invoke("candidates:cancel", id),
  getAudio: (id)           => ipcRenderer.invoke("candidates:getAudio", id),
  onChanged:  subscribable("candidates:changed"),
  onProgress: subscribable("candidates:progress"),
});
