export default function SeverityBadge({ severity }) {
  const labels = {
    P0: "P0 — Critical",
    P1: "P1 — High",
    P2: "P2 — Medium",
    P3: "P3 — Low",
  };
  const s = String(severity || "").slice(0, 2);
  return <span className={`badge ${s}`}>{labels[s] || severity}</span>;
}
