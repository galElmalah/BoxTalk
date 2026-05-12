const NAV = [
  { id: "queue",   label: "Queue"   },
  { id: "general", label: "General" },
  { id: "model",   label: "Model"   },
  { id: "history", label: "History" },
  { id: "speak",   label: "Speak"   },
];

export function Sidebar({ view, onNavigate, queueCount = 0 }) {
  return (
    <aside className="sidebar" aria-label="Navigation">
      <h1 className="app-name" id="app-name">BoxTalk</h1>
      <nav>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={"nav-item" + (view === n.id ? " active" : "")}
            data-nav={n.id}
            onClick={() => onNavigate(n.id)}
          >
            <span className="nav-dot" aria-hidden="true" />
            {n.label}
            {n.id === "queue" && queueCount > 0 && (
              <span className="nav-badge" data-nav-badge={n.id}>{queueCount}</span>
            )}
          </button>
        ))}
      </nav>
    </aside>
  );
}
