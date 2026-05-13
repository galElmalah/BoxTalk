import { useEffect, useState } from "react";

export function GeneralView({ active, modelLabel, maxHistory, onSetMaxHistory }) {
  const [token, setToken] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!active || token) return;
    if (!window.bridge?.getToken) return;
    window.bridge.getToken().then(setToken).catch(() => {});
  }, [active, token]);

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("clipboard:", err);
    }
  };

  return (
    <section className={"view" + (active ? " active" : "")} data-view="general">
      <header className="view-header">
        <h2>General</h2>
        <p className="view-subtitle">App-level settings.</p>
      </header>

      <div className="card">
        <div className="row">
          <div className="row-text">
            <span className="row-title">Selected model</span>
            <span className="row-sub" id="general-model">{modelLabel}</span>
          </div>
        </div>
        <div className="row">
          <div className="row-text">
            <span className="row-title">Max history entries</span>
            <span className="row-sub">Older entries are dropped automatically.</span>
          </div>
          <input
            type="number"
            id="max-history"
            className="number-input"
            min={1}
            max={1000}
            value={maxHistory}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              if (Number.isFinite(parsed)) onSetMaxHistory(parsed);
            }}
          />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="row-text">
            <span className="row-title">Browser extension</span>
            <span className="row-sub">
              Paste this pairing token into the BoxTalk Chrome extension to let it send web pages here.
              The bridge listens on <code>127.0.0.1:38219</code>.
            </span>
          </div>
        </div>
        <div className="row">
          <code className="bridge-token" id="bridge-token">{token ?? "…"}</code>
          <button
            type="button"
            id="bridge-token-copy"
            className="ghost"
            disabled={!token}
            onClick={copy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </section>
  );
}
