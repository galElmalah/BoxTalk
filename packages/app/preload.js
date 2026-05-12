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
  digest:   (id, voice, speed) => ipcRenderer.invoke("candidates:digest", { id, voice, speed }),
  cancel:   (id)           => ipcRenderer.invoke("candidates:cancel", id),
  getAudio: (id)           => ipcRenderer.invoke("candidates:getAudio", id),
  onChanged:  subscribable("candidates:changed"),
  onProgress: subscribable("candidates:progress"),
});
