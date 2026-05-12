// useState backed by the SQLite settings table.
//
//   const [text, setText] = usePersistedState("speakDraft.text", "", { debounceMs: 400 });
//
// Hydrates from SQLite on mount. All writes are JSON-encoded and debounced so
// a fast typist doesn't hammer the DB. The string returned by setX is the
// in-memory value — persistence happens asynchronously.

import { useCallback, useEffect, useRef, useState } from "react";

export function usePersistedState(key, defaultValue, { debounceMs = 0 } = {}) {
  const [value, setValue] = useState(defaultValue);
  const [hydrated, setHydrated] = useState(false);
  // If the user (or a test) writes before the async hydrate completes, the
  // hydrate must NOT clobber that write. This ref tracks that race.
  const userChanged = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!window.store?.getSetting) { setHydrated(true); return; }
    window.store.getSetting(key).then((raw) => {
      if (cancelled) return;
      if (raw != null && raw !== "" && !userChanged.current) {
        try { setValue(JSON.parse(raw)); }
        catch { /* malformed setting — fall back to default */ }
      }
      setHydrated(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!hydrated || !window.store?.setSetting) return;
    if (timer.current) clearTimeout(timer.current);
    const write = () => {
      window.store.setSetting(key, JSON.stringify(value))
        .catch((err) => console.error(`persist ${key}:`, err));
    };
    if (debounceMs > 0) timer.current = setTimeout(write, debounceMs);
    else write();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [hydrated, value, key, debounceMs]);

  const update = useCallback((next) => {
    userChanged.current = true;
    setValue((prev) => typeof next === "function" ? next(prev) : next);
  }, []);

  return [value, update, hydrated];
}
