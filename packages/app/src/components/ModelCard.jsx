import { ScoreBadge } from "./ScoreBadge.jsx";
import { StateBadge } from "./StateBadge.jsx";
import { ProgressBar } from "./ProgressBar.jsx";
import { RunModePills } from "./RunModePills.jsx";
import { VoiceRow } from "./VoiceRow.jsx";

// Each accordion card. Closed: just the header. Open: download row, optional
// progress + error, run modes, and the voice list.
export function ModelCard({
  model,
  state,
  runMode,
  expanded,
  selectedVoiceId,
  previewingVoice,
  previewLoading,
  onToggleExpand,
  onLoad,
  onSetRunMode,
  onSelectVoice,
  onTogglePreview,
}) {
  const isReady = state.state === "ready";
  const isLoading = state.state === "loading";

  return (
    <div className="model-card" data-model={model.id} data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="model-card-header"
        aria-expanded={expanded}
        onClick={onToggleExpand}
      >
        <div className="model-card-title">
          <span className="name">{model.label}</span>
          <span className="desc">{model.description}</span>
        </div>
        <div className="model-card-meta">
          <ScoreBadge label="Speed" value={model.speed} />
          <ScoreBadge label="Fluency" value={model.fluency} />
          <StateBadge state={state.state} />
          <span className="chevron">▾</span>
        </div>
      </button>

      {expanded && (
        <div className="model-card-body">
          <div className="download-row">
            <span className="size-label">Download size: {model.sizeLabel}</span>
            {(state.state === "idle" || state.state === "error") && (
              <button
                type="button"
                className="ghost small load-btn"
                onClick={(e) => { e.stopPropagation(); onLoad(); }}
              >
                {state.state === "error" ? "Retry download" : "Download / load"}
              </button>
            )}
          </div>

          {isLoading && <ProgressBar progress={state.progress} />}

          {state.state === "error" && state.error && (
            <div className="model-error">{state.error}</div>
          )}

          <RunModePills
            modes={model.runModes}
            value={runMode}
            onChange={(mode) => onSetRunMode(mode)}
          />

          <div className="voices-title">Voices</div>
          <div className="voice-list">
            {model.voices.map((v) => (
              <VoiceRow
                key={v.id}
                voice={v}
                model={model}
                selected={v.id === selectedVoiceId}
                ready={isReady}
                previewing={previewingVoice === v.id}
                previewLoading={previewingVoice === v.id && previewLoading}
                onSelect={() => onSelectVoice(v.id)}
                onTogglePreview={() => onTogglePreview(v)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
