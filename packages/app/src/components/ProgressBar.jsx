// Inline per-model progress UI: file name, percent, MB / MB, and a bar.
// `progress` is whatever the backend last emitted; missing fields render as
// placeholders so the bar still shows during the indeterminate phase.

export function ProgressBar({ progress }) {
  const p = progress ?? {};
  const pct = typeof p.progress === "number" ? Math.max(0, Math.min(100, p.progress)) : null;

  const detail = (() => {
    if (p.loaded && p.total) {
      return `${(p.loaded / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB`;
    }
    return p.stage || "Downloading…";
  })();

  return (
    <div className="model-progress-inline">
      <div className="progress-row">
        <span className="progress-file">{p.file ?? "Preparing…"}</span>
        <span className="progress-pct">{pct != null ? `${pct.toFixed(0)}%` : ""}</span>
      </div>
      <div className="progress-detail">{detail}</div>
      <div className="progress-bar">
        <div
          className={"progress-fill" + (pct == null ? " indeterminate" : "")}
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
