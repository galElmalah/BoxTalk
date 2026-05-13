import { MODELS } from "../data/models.js";
import { ModelCard } from "./ModelCard.jsx";

export function ModelView({
  active,
  modelStates,
  runModes,
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
  return (
    <section className={"view" + (active ? " active" : "")} data-view="model">
      <header className="view-header">
        <h2>Models</h2>
        <p className="view-subtitle">
          Pick a model and a voice. Each card downloads + caches independently.
        </p>
      </header>

      <div className="model-accordion" id="model-accordion">
        {MODELS.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            state={modelStates[m.id]}
            runMode={runModes[m.id]}
            expanded={expanded.has(m.id)}
            selectedVoiceId={selectedVoiceId}
            previewingVoice={previewingVoice}
            previewLoading={previewLoading}
            onToggleExpand={() => onToggleExpand(m.id)}
            onLoad={() => onLoad(m.id)}
            onSetRunMode={(mode) => onSetRunMode(m.id, mode)}
            onSelectVoice={onSelectVoice}
            onTogglePreview={(voice) => onTogglePreview(voice, m)}
          />
        ))}
      </div>
    </section>
  );
}
