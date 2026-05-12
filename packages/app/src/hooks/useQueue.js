// Saved-narration candidates with digestion state. The list is rehydrated on
// every "candidates:changed" broadcast (cheap — small table); progress is a
// separate stream keyed by candidate id.

import { useCallback, useEffect, useState } from "react";

export function useQueue() {
  const [items, setItems] = useState([]);
  const [progress, setProgress] = useState({}); // id → { state, chunkIndex, chunkCount, error }

  const refresh = useCallback(async () => {
    if (!window.queue) return;
    setItems(await window.queue.list());
  }, []);

  useEffect(() => {
    refresh();
    if (!window.queue) return;
    const off1 = window.queue.onChanged(() => { refresh(); });
    const off2 = window.queue.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }));
    });
    return () => { off1?.(); off2?.(); };
  }, [refresh]);

  const remove = useCallback(async (id) => {
    await window.queue.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
    setProgress((p) => { const { [id]: _, ...rest } = p; return rest; });
  }, []);

  const clear = useCallback(async () => {
    await window.queue.clear();
    setItems([]);
    setProgress({});
  }, []);

  const digest = useCallback(async (id, voice) => {
    try {
      await window.queue.digest(id, voice);
    } catch (err) {
      console.error("digest:", err);
    }
  }, []);

  const cancel = useCallback(async (id) => {
    await window.queue.cancel(id);
  }, []);

  return { items, progress, refresh, remove, clear, digest, cancel };
}
