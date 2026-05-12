import { voiceById } from "../data/models.js";

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryItem({ entry }) {
  const v = voiceById(entry.voice);
  return (
    <div className="history-item" data-id={entry.id}>
      <div className="h-text">{entry.text}</div>
      <div className="h-meta">
        <span className="tag source">{entry.source}</span>
        <span className="tag">{v ? `${v.label} (${v.accent})` : entry.voice}</span>
        <span className="tag">{formatTimestamp(entry.timestamp)}</span>
        {entry.durationSec ? (
          <span className="tag">{entry.durationSec.toFixed(1)}s audio</span>
        ) : null}
        {entry.synthMs != null ? (
          <span className="tag">generated in {(entry.synthMs / 1000).toFixed(2)}s</span>
        ) : null}
      </div>
    </div>
  );
}
