export function RunModePills({ modes, value, onChange }) {
  if (!modes || modes.length === 0) return null;
  return (
    <div className="run-modes">
      <span className="field-label">Run mode</span>
      <div className="run-mode-pills">
        {modes.map((rm) => (
          <button
            key={rm.id}
            type="button"
            className={"mode-pill" + (value === rm.id ? " active" : "")}
            onClick={(e) => { e.stopPropagation(); onChange(rm.id); }}
          >
            {rm.label}
          </button>
        ))}
      </div>
    </div>
  );
}
