export function ScoreBadge({ label, value }) {
  return (
    <span className="score">
      <span className="score-label">{label}</span>
      <span className="score-value">{value}/10</span>
    </span>
  );
}
