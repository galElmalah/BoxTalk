// Queue view: two columns side-by-side.
//   - Pending  → text waiting to be turned into audio (status: pending|digesting)
//   - Digested → audio files ready to listen (status: digested)
//
// A toolbar at the top lets the user pick the digest voice + speed before
// hitting "Digest". Digested cards show pause + a seek slider with a hover
// popover that surfaces the m:ss the slider is hovering over.

import { useRef, useState } from "react";
import { MODELS, voiceById } from "../data/models.js";
import { usePersistedState } from "../hooks/usePersistedState.js";

const PREVIEW_CHARS = 240;
const KOKORO_VOICES = MODELS[0].voices;

function ellipsize(text, max = PREVIEW_CHARS) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function formatTimestamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    hour: "2-digit", minute: "2-digit", month: "short", day: "numeric",
  });
}

function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return "";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function hostFromUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

function SeekBar({ currentTime, duration, onSeek }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null); // { x: number, t: number } | null
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const fromPointer = (clientX) => {
    const el = ref.current;
    if (!el || dur <= 0) return null;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { ratio, x: ratio * rect.width, t: ratio * dur };
  };

  const handleMove = (e) => {
    const r = fromPointer(e.clientX);
    if (r) setHover({ x: r.x, t: r.t });
  };

  return (
    <div className="q-seek">
      <span className="q-seek-time">{formatClock(currentTime)}</span>
      <div
        className="q-seek-track"
        ref={ref}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <input
          type="range"
          min={0}
          max={dur > 0 ? dur : 1}
          step={0.05}
          value={Math.min(currentTime, dur || currentTime)}
          disabled={dur <= 0}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          aria-label="Seek"
        />
        {hover && (
          <span
            className="q-seek-tooltip"
            style={{ left: `${hover.x}px` }}
            aria-hidden="true"
          >
            {formatClock(hover.t)}
          </span>
        )}
      </div>
      <span className="q-seek-time">{formatClock(dur)}</span>
    </div>
  );
}

function CandidateCard({
  item, progress, isPlaying, paused, currentTime, duration,
  digestVoice, digestSpeed,
  onDigest, onCancel, onPlay, onPause, onResume, onSeek, onDismiss,
}) {
  const [expanded, setExpanded] = useState(false);
  const digesting = item.status === "digesting" || progress?.state === "digesting";
  const host = hostFromUrl(item.sourceUrl);
  const chars = (item.text || "").length;

  return (
    <li className={"q-card status-" + item.status} data-id={item.id} data-status={item.status}>
      <div className="q-head">
        {item.title ? (
          <div className="q-title" title={item.title}>{item.title}</div>
        ) : (
          <div className="q-title q-title-fallback">{ellipsize(item.text, 60)}</div>
        )}
        <button
          type="button"
          className="q-icon"
          title="Remove from queue"
          data-action="dismiss"
          onClick={() => onDismiss(item.id)}
        >×</button>
      </div>

      <div className="q-meta">
        {host && item.sourceUrl ? (
          <a className="q-host" href={item.sourceUrl} target="_blank" rel="noreferrer" title={item.sourceUrl}>
            {host}
          </a>
        ) : (
          <span className="q-host muted">{item.source || "Extension"}</span>
        )}
        <span className="q-chars">{chars.toLocaleString()} chars</span>
        <span className="q-time">{formatTimestamp(item.timestamp)}</span>
        {item.status === "digested" && (
          <span className="q-duration">{formatDuration(item.durationSec)}</span>
        )}
      </div>

      <div className="q-text">
        {expanded ? item.text : ellipsize(item.text, PREVIEW_CHARS)}
      </div>
      {chars > PREVIEW_CHARS && (
        <button
          type="button"
          className="q-expand"
          data-action="toggle-text"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Hide full text" : "Show full text"}
        </button>
      )}

      {item.error && !digesting && (
        <div className="q-error">Last digest failed: {item.error}</div>
      )}

      {digesting && progress && (
        <div className="q-progress">
          <div className="q-progress-bar">
            <div
              className="q-progress-fill"
              style={{
                width: progress.chunkCount
                  ? `${Math.round(((progress.chunkIndex ?? 0) / progress.chunkCount) * 100)}%`
                  : "0%",
              }}
            />
          </div>
          <span className="q-progress-label">
            Digesting {(progress.chunkIndex ?? 0) + 1} / {progress.chunkCount}
          </span>
        </div>
      )}

      {item.status === "digested" && isPlaying && (
        <SeekBar
          currentTime={currentTime}
          duration={duration || item.durationSec || 0}
          onSeek={onSeek}
        />
      )}

      <div className="q-actions">
        {item.status === "pending" && (
          <button
            type="button"
            className="primary small"
            data-action="digest"
            onClick={() => onDigest(item.id, { voice: digestVoice, speed: digestSpeed })}
            title={`Digest with ${voiceById(digestVoice)?.label ?? digestVoice} at ${digestSpeed.toFixed(2)}×`}
          >
            Digest
          </button>
        )}
        {digesting && (
          <button type="button" className="ghost small" data-action="cancel" onClick={() => onCancel(item.id)}>
            Cancel
          </button>
        )}
        {item.status === "digested" && (
          <>
            <button
              type="button"
              className={"primary small" + (isPlaying && !paused ? " is-playing" : "")}
              data-action={isPlaying ? (paused ? "resume" : "pause") : "play"}
              onClick={() => {
                if (!isPlaying) return onPlay(item);
                if (paused) return onResume();
                return onPause();
              }}
            >
              {!isPlaying ? "Play" : paused ? "Resume" : "Pause"}
            </button>
            {isPlaying && (
              <button type="button" className="ghost small" data-action="stop-digest" onClick={() => onPlay(item)}>
                Stop
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function QueueView({
  active,
  items,
  progress,
  playingId,
  paused,
  currentTime,
  duration,
  defaultVoiceId,
  onDigest,
  onCancel,
  onPlay,
  onPause,
  onResume,
  onSeek,
  onDismiss,
  onClear,
}) {
  const pending = items.filter((x) => x.status !== "digested");
  const digested = items.filter((x) => x.status === "digested");

  // Per-queue digest settings — persisted so the choice survives reloads.
  const [voice, setVoice] = usePersistedState("queue.digestVoice", defaultVoiceId);
  const [speed, setSpeed] = usePersistedState("queue.digestSpeed", 1.0);

  // If the persisted voice references a removed entry, fall back to default.
  const safeVoice = voiceById(voice) ? voice : defaultVoiceId;

  return (
    <section className={"view" + (active ? " active" : "")} data-view="queue">
      <header className="view-header">
        <h2>Queue</h2>
        <p className="view-subtitle">
          Pages and selections from the Chrome extension. <strong>Digest</strong> turns the text
          into an audio file so you can listen later, even offline.
        </p>
      </header>

      <div className="q-toolbar">
        <label className="q-toolbar-field">
          <span className="q-toolbar-label">Voice</span>
          <select
            id="queue-voice"
            value={safeVoice}
            onChange={(e) => setVoice(e.target.value)}
          >
            {KOKORO_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} — {v.accent}
              </option>
            ))}
          </select>
        </label>
        <label className="q-toolbar-field q-toolbar-field-speed">
          <span className="q-toolbar-label">
            Speed <span className="hint">{speed.toFixed(2)}×</span>
          </span>
          <input
            id="queue-speed"
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value) || 1)}
          />
        </label>
        <span className="q-toolbar-note">
          Applied when you hit <strong>Digest</strong>. Already-digested audio keeps the
          voice + speed it was rendered with.
        </span>
      </div>

      <div className="history-toolbar">
        <span className="hint">
          {pending.length} pending · {digested.length} digested
        </span>
        <button
          type="button"
          id="queue-clear"
          className="ghost danger"
          disabled={items.length === 0}
          onClick={onClear}
        >
          Clear all
        </button>
      </div>

      <div className="q-columns">
        <div className="q-column" data-col="pending">
          <h3 className="q-column-title">
            Waiting <span className="q-count">{pending.length}</span>
          </h3>
          {pending.length === 0 ? (
            <div className="empty-state">
              No text waiting. Use the Chrome extension's <em>Save for later</em> button.
            </div>
          ) : (
            <ul className="q-list">
              {pending.map((item) => (
                <CandidateCard
                  key={item.id}
                  item={item}
                  progress={progress[item.id]}
                  isPlaying={false}
                  paused={false}
                  currentTime={0}
                  duration={0}
                  digestVoice={safeVoice}
                  digestSpeed={speed}
                  onDigest={onDigest}
                  onCancel={onCancel}
                  onPlay={onPlay}
                  onPause={onPause}
                  onResume={onResume}
                  onSeek={onSeek}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="q-column" data-col="digested">
          <h3 className="q-column-title">
            Digested <span className="q-count">{digested.length}</span>
          </h3>
          {digested.length === 0 ? (
            <div className="empty-state">
              Click <strong>Digest</strong> on a waiting card to pre-render its audio.
            </div>
          ) : (
            <ul className="q-list">
              {digested.map((item) => (
                <CandidateCard
                  key={item.id}
                  item={item}
                  progress={progress[item.id]}
                  isPlaying={playingId === item.id}
                  paused={playingId === item.id && paused}
                  currentTime={playingId === item.id ? currentTime : 0}
                  duration={playingId === item.id ? duration : item.durationSec || 0}
                  digestVoice={safeVoice}
                  digestSpeed={speed}
                  onDigest={onDigest}
                  onCancel={onCancel}
                  onPlay={onPlay}
                  onPause={onPause}
                  onResume={onResume}
                  onSeek={onSeek}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
