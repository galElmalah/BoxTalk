import { useMemo, useState } from "react";
import { HistoryItem } from "./HistoryItem.jsx";
import { voiceById } from "../data/models.js";

export function HistoryView({ active, items, onClear }) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((h) => {
      const v = voiceById(h.voice);
      const haystack = [h.text, h.voice, v?.label, v?.accent, h.source].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [items, filter]);

  const isEmpty = visible.length === 0;
  const emptyMsg = isEmpty && filter
    ? `No matches for "${filter}".`
    : "No history yet. Generate some speech to see it here.";

  return (
    <section className={"view" + (active ? " active" : "")} data-view="history">
      <header className="view-header">
        <h2>History</h2>
        <p className="view-subtitle">Everything you've had read aloud.</p>
      </header>

      <div className="history-toolbar">
        <input
          id="history-search"
          type="search"
          placeholder="Search text or voice…"
          autoComplete="off"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          id="history-clear"
          className="ghost small"
          onClick={() => {
            if (items.length > 0) onClear();
          }}
        >
          Clear
        </button>
      </div>

      <div className="history-list" id="history-list">
        {visible.map((h) => <HistoryItem key={h.id} entry={h} />)}
      </div>
      <p className={"empty" + (isEmpty ? " visible" : "")} id="history-empty">
        {emptyMsg}
      </p>
    </section>
  );
}
