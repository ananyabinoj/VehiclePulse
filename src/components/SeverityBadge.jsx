export default function SeverityBadge({ severity, engine }) {
  const labels = {
    P0: "P0 — Critical",
    P1: "P1 — High",
    P2: "P2 — Medium",
    P3: "P3 — Low",
  };
  if (!severity) return <span className="pill pill-pending">Not yet triaged</span>;
  const s = String(severity).slice(0, 2);
  return (
    <span className="sev-wrap">
      <span className={`badge ${s}`}>{labels[s] || severity}</span>
      {engine ? <span className="pill">{engine}</span> : null}
    </span>
  );
}
