// History list + max-history setting, persisted via window.store (SQLite in main).

import { useCallback, useEffect, useState } from "react";

export function useHistory() {
  const [items, setItems] = useState([]);
  const [maxHistory, setMaxHistoryState] = useState(20);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      const [list, max] = await Promise.all([
        window.store.listHistory(),
        window.store.getMaxHistory(),
      ]);
      setItems(list);
      setMaxHistoryState(max);
      setHydrated(true);
    })();
  }, []);

  const refresh = useCallback(async () => {
    setItems(await window.store.listHistory());
  }, []);

  const add = useCallback(async (entry) => {
    await window.store.addHistory(entry);
    await refresh();
  }, [refresh]);

  const clear = useCallback(async () => {
    await window.store.clearHistory();
    setItems([]);
  }, []);

  const setMaxHistory = useCallback(async (n) => {
    const clamped = await window.store.setMaxHistory(n);
    setMaxHistoryState(clamped);
    await refresh();
    return clamped;
  }, [refresh]);

  return { items, maxHistory, hydrated, add, clear, setMaxHistory };
}
