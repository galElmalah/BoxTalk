const LABELS = {
  idle: "Not loaded",
  loading: "Loading",
  ready: "Ready",
  error: "Error",
};

export function StateBadge({ state }) {
  return (
    <span className="model-state" data-state={state}>
      {state === "loading" && (
        <span className="wave" aria-hidden="true">
          <i /><i /><i /><i /><i />
        </span>
      )}
      <span className="model-state-text">{LABELS[state] ?? state}</span>
    </span>
  );
}
