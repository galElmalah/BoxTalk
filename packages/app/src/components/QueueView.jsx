// Queue view: two columns side-by-side.
//   - Pending  → text waiting to be turned into audio (status: pending|digesting)
//   - Digested → audio files ready to listen (status: digested)
//
// The toolbar only sets the voice used at digest time — speed is *not* baked
// into the WAV. Once a card is digested, it surfaces an always-visible
// transport panel: skip back 30s, play/pause, skip forward 30s, a draggable
// seek bar with a hover tooltip showing m:ss, and a playback-speed segmented
// control that drives audio.playbackRate live.

import { useRef, useState } from "react";
import { MODELS, voiceById } from "../data/models.js";
import { usePersistedState } from "../hooks/usePersistedState.js";

const PREVIEW_CHARS = 240;
const KOKORO_VOICES = MODELS[0].voices;
const SKIP_SECONDS = 30;
const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

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

// ── Transport icons ──────────────────────────────────────────────────
// Inline SVGs so the transport has the weight + polish of a real audio
// player without pulling in an icon library. 18px viewport, currentColor.

function IconPlay() {
  return (
    <svg className="q-icon-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M5 3.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 5 3.5Z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg className="q-icon-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="4.5" y="3" width="3" height="12" rx="1" fill="currentColor" />
      <rect x="10.5" y="3" width="3" height="12" rx="1" fill="currentColor" />
    </svg>
  );
}

// Counter-clockwise replay arrow with "30" inside.
function IconSkipBack() {
  return (
    <svg className="q-icon-svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="12" y="17" textAnchor="middle" fontSize="7" fontWeight="600" fill="currentColor">30</text>
    </svg>
  );
}

// Clockwise forward arrow with "30" inside.
function IconSkipFwd() {
  return (
    <svg className="q-icon-svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="12" y="17" textAnchor="middle" fontSize="7" fontWeight="600" fill="currentColor">30</text>
    </svg>
  );
}

// ── Seek bar with hover tooltip ──────────────────────────────────────

function SeekBar({ currentTime, duration, onSeek, disabled }) {
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

  const playedPct = dur > 0 ? Math.min(100, (currentTime / dur) * 100) : 0;

  return (
    <div
      className={"q-seek-track" + (disabled ? " is-disabled" : "")}
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={() => setHover(null)}
    >
      <div className="q-seek-rail" aria-hidden="true">
        <div className="q-seek-played" style={{ width: `${playedPct}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={dur > 0 ? dur : 1}
        step={0.05}
        value={Math.min(currentTime, dur || currentTime)}
        disabled={disabled || dur <= 0}
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
  );
}

// ── Playback transport (always visible on digested cards) ────────────

function Transport({
  isPlaying, paused, currentTime, duration, playbackRate,
  onPlayToggle, onSeek, onPlaybackRateChange,
}) {
  const dur = duration || 0;
  const skipBack = () => onSeek(Math.max(0, currentTime - SKIP_SECONDS));
  const skipFwd = () => onSeek(Math.min(dur, currentTime + SKIP_SECONDS));
  const showPause = isPlaying && !paused;

  return (
    <div className="q-transport" role="group" aria-label="Playback controls">
      <div className="q-transport-row">
        <div className="q-transport-buttons">
          <button
            type="button"
            className="q-skip"
            data-action="skip-back"
            title="Back 30 seconds"
            aria-label="Back 30 seconds"
            onClick={skipBack}
          >
            <IconSkipBack />
          </button>
          <button
            type="button"
            className={"q-play-toggle" + (showPause ? " is-playing" : "")}
            data-action={showPause ? "pause" : "play"}
            title={showPause ? "Pause" : (isPlaying && paused ? "Resume" : "Play")}
            aria-label={showPause ? "Pause" : "Play"}
            onClick={onPlayToggle}
          >
            {showPause ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="q-skip"
            data-action="skip-fwd"
            title="Forward 30 seconds"
            aria-label="Forward 30 seconds"
            onClick={skipFwd}
          >
            <IconSkipFwd />
          </button>
        </div>

        <div className="q-transport-scrub">
          <span className="q-seek-time">{formatClock(currentTime)}</span>
          <SeekBar
            currentTime={currentTime}
            duration={dur}
            onSeek={onSeek}
            disabled={!isPlaying}
          />
          <span className="q-seek-time q-seek-time-end">{formatClock(dur)}</span>
        </div>
      </div>

      <div className="q-transport-row q-transport-row-secondary">
        <span className="q-rate-label">Speed</span>
        <div className="q-rate-segmented" role="radiogroup" aria-label="Playback speed">
          {SPEED_OPTIONS.map((rate) => {
            const active = Math.abs(playbackRate - rate) < 0.001;
            return (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={active}
                className={"q-rate-option" + (active ? " is-active" : "")}
                data-rate={rate}
                onClick={() => onPlaybackRateChange(rate)}
              >
                {rate === 1 ? "1×" : `${rate}×`}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Candidate cards ──────────────────────────────────────────────────

function CandidateCard({
  item, progress, isPlaying, paused, currentTime, duration, playbackRate,
  digestVoice,
  onDigest, onCancel, onPlay, onPause, onResume, onSeek, onPlaybackRateChange, onDismiss,
}) {
  const [expanded, setExpanded] = useState(false);
  const digesting = item.status === "digesting" || progress?.state === "digesting";
  const host = hostFromUrl(item.sourceUrl);
  const chars = (item.text || "").length;

  const handlePlayToggle = () => {
    if (!isPlaying) return onPlay(item);
    if (paused) return onResume();
    return onPause();
  };

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

      {item.status === "digested" && (
        <Transport
          isPlaying={isPlaying}
          paused={paused}
          currentTime={currentTime}
          duration={duration || item.durationSec || 0}
          playbackRate={playbackRate}
          onPlayToggle={handlePlayToggle}
          onSeek={onSeek}
          onPlaybackRateChange={onPlaybackRateChange}
        />
      )}

      {item.status === "pending" && (
        <div className="q-actions">
          <button
            type="button"
            className="primary small"
            data-action="digest"
            onClick={() => onDigest(item.id, { voice: digestVoice })}
            title={`Digest with ${voiceById(digestVoice)?.label ?? digestVoice}`}
          >
            Digest
          </button>
        </div>
      )}
      {digesting && (
        <div className="q-actions">
          <button type="button" className="ghost small" data-action="cancel" onClick={() => onCancel(item.id)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

// ── View ─────────────────────────────────────────────────────────────

export function QueueView({
  active,
  items,
  progress,
  playingId,
  paused,
  currentTime,
  duration,
  playbackRate,
  defaultVoiceId,
  onDigest,
  onCancel,
  onPlay,
  onPause,
  onResume,
  onSeek,
  onPlaybackRateChange,
  onDismiss,
  onClear,
}) {
  const pending = items.filter((x) => x.status !== "digested");
  const digested = items.filter((x) => x.status === "digested");

  // Voice chosen here is baked into every digest that gets rendered. Speed
  // intentionally lives elsewhere — it's a playback setting, not a
  // synthesis setting. Default: Heart.
  const [voice, setVoice] = usePersistedState("queue.digestVoice", "af_heart");
  const safeVoice = voiceById(voice) ? voice : (defaultVoiceId || "af_heart");

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
        <label className="q-toolbar-field" htmlFor="queue-voice">
          <span className="q-toolbar-label">Voice for new digests</span>
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
                  playbackRate={playbackRate}
                  digestVoice={safeVoice}
                  onDigest={onDigest}
                  onCancel={onCancel}
                  onPlay={onPlay}
                  onPause={onPause}
                  onResume={onResume}
                  onSeek={onSeek}
                  onPlaybackRateChange={onPlaybackRateChange}
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
                  playbackRate={playbackRate}
                  digestVoice={safeVoice}
                  onDigest={onDigest}
                  onCancel={onCancel}
                  onPlay={onPlay}
                  onPause={onPause}
                  onResume={onResume}
                  onSeek={onSeek}
                  onPlaybackRateChange={onPlaybackRateChange}
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
