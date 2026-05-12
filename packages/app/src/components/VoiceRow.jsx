const ICON_PLAY = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
    <path d="M7 5v14l12-7z" />
  </svg>
);

const ICON_STOP = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

// One row in a model's voice list. Two interaction points: clicking the row
// selects the voice for use in Speak; clicking the preview button plays a
// short sample. Disabled when the parent model isn't loaded.
export function VoiceRow({ voice, model, selected, ready, previewing, previewLoading, onSelect, onTogglePreview }) {
  const handleKey = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  let previewClass = "preview-btn";
  if (previewing && previewLoading) previewClass += " loading";
  else if (previewing) previewClass += " playing";

  return (
    <div
      className={"voice-option" + (selected ? " active" : "") + (!ready ? " not-ready" : "")}
      data-voice={voice.id}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.target.closest(".preview-btn")) return;
        onSelect();
      }}
      onKeyDown={handleKey}
    >
      <button
        type="button"
        className={previewClass}
        data-preview={voice.id}
        aria-label={`Preview ${voice.label}`}
        disabled={!ready}
        onClick={(e) => { e.stopPropagation(); onTogglePreview(); }}
      >
        {previewing && !previewLoading ? ICON_STOP : ICON_PLAY}
      </button>
      <span className="voice-name">
        <span>
          <strong>{voice.label}</strong>
          <span className="hint"> — {voice.accent}</span>
        </span>
        <span className="id">{voice.id}</span>
      </span>
      <span className="check" aria-hidden="true" />
    </div>
  );
}
