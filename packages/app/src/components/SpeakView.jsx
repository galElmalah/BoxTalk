import { usePersistedState } from "../hooks/usePersistedState.js";

const DEFAULT_TEXT = "Life is like a box of chocolates. You never know what you're gonna get.";

export function SpeakView({
  active,
  voice,
  model,
  modelReady,
  busy,
  playing,
  error,
  onSpeak,
  onStop,
}) {
  // Draft text + speed live in SQLite so they survive reloads.
  const [text, setText]   = usePersistedState("speakDraft.text",  DEFAULT_TEXT, { debounceMs: 400 });
  const [speed, setSpeed] = usePersistedState("speakDraft.speed", 1.0);

  const canSpeak = modelReady && !busy && text.trim().length > 0;

  return (
    <section className={"view" + (active ? " active" : "")} data-view="speak">
      <header className="view-header">
        <h2>Speak</h2>
        <p className="view-subtitle">
          Type something and have <span data-app-name>BoxTalk</span> read it back.
        </p>
      </header>

      <div className="meta-row">
        <div className="meta-pair">
          <span className="meta-label">Voice</span>
          <span className="meta-value" id="current-voice-label">
            {voice ? `${voice.label} — ${voice.accent}` : "—"}
          </span>
        </div>
        <div className="meta-pair">
          <span className="meta-label">Model</span>
          <span className="meta-value" id="current-model-label">
            {model ? model.label : "—"}
          </span>
        </div>
      </div>

      <label className="field">
        <span className="field-label">
          Speed <span className="hint" id="speed-value">{speed.toFixed(2)}×</span>
        </span>
        <input
          id="speed"
          type="range"
          min="0.5"
          max="1.5"
          step="0.05"
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value) || 1)}
        />
      </label>

      <label className="field">
        <span className="field-label">Text</span>
        <textarea
          id="text"
          rows={9}
          placeholder="Type something to read aloud…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          id="speak"
          className={"primary" + (busy ? " busy" : "")}
          disabled={!canSpeak}
          onClick={() => onSpeak({ text: text.trim(), speed })}
        >
          <span className="btn-label">Speak</span>
          <span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        </button>
        <button
          type="button"
          id="stop"
          className="ghost"
          disabled={!playing}
          onClick={onStop}
        >
          Stop
        </button>
      </div>

      {error && <div id="speak-error" className="speak-error">{error}</div>}
    </section>
  );
}
