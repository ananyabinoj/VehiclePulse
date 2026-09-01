import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import SeverityBadge from "../components/SeverityBadge.jsx";

export default function ThemeDetail() {
  const { id } = useParams();
  const [theme, setTheme] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    setTheme(null);
    fetch(`/api/themes/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Theme not found");
        return r.json();
      })
      .then(setTheme)
      .catch((e) => setErr(String(e.message || e)));
  }, [id]);

  if (err) return <main className="page">{err} — <Link to="/themes">Back</Link></main>;
  if (!theme) return <main className="page">Loading…</main>;

  const dist = theme.severityDistribution || {};

  return (
    <main className="page">
      <p>
        <Link to="/themes">← Recurring Themes</Link>
      </p>
      <h2>{theme.name}</h2>
      <p className="lede">{theme.description}</p>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Why it matters</h3>
        <p style={{ margin: 0 }}>{theme.whyItMatters}</p>
      </div>

      <div className="grid-4">
        <div className="card metric">
          <div className="k">Affected vehicles</div>
          <div className="v">{theme.affectedVehicles.toLocaleString()}</div>
        </div>
        <div className="card metric">
          <div className="k">Priority score</div>
          <div className="v">{theme.priorityScore.toLocaleString()}</div>
        </div>
        <div className="card metric">
          <div className="k">Reports</div>
          <div className="v">{theme.reportCount}</div>
        </div>
        <div className="card metric">
          <div className="k">Peak severity</div>
          <div className="v" style={{ fontSize: 18 }}>
            <SeverityBadge severity={theme.severity} />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Severity distribution</h3>
        <div className="dist">
          {["P0", "P1", "P2", "P3"].map((s) => (
            <span key={s} className={`badge ${s}`}>
              {s}: {dist[s] || 0}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>What we&apos;re seeing</h3>
        <ul>
          {(theme.seeing || []).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Common triggers</h3>
        {(theme.commonTriggers || []).map((x) => (
          <div key={x.label}>
            {x.label} ({x.count})
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Common recovery paths</h3>
        {(theme.commonRecovery || []).map((x) => (
          <div key={x.label}>
            {x.label} ({x.count})
          </div>
        ))}
      </div>

      <div className="summary-box">
        <h3>Suggested product improvement</h3>
        <p style={{ margin: 0 }}>{theme.productImprovement}</p>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Reports contributing to this theme</h3>
        {(theme.reports || []).map((r) => (
          <div key={r.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
            <strong>{r.id}</strong> · {r.vehicleModel} · {r.softwareVersion} · {r.affectedVehicles} veh.{" "}
            <SeverityBadge severity={r.severity} />
            <p className="reason">{r.triageSummary}</p>
            <details className="details" open={openId === r.id} onToggle={(e) => e.target.open && setOpenId(r.id)}>
              <summary>Details</summary>
              <p>
                <em>Raw:</em> {r.rawText}
              </p>
              <p>Source: {r.source} · {r.location} · {r.date}</p>
              <p>Subsystem: {r.subsystem}</p>
              <p>Severity reason: {r.severityReason}</p>
              <p>
                Recovery: {r.recoveryPath} — {r.recoveryReason}
              </p>
              <p>
                Trigger: {r.triggerCondition} — {r.triggerReason}
              </p>
              <p>
                Owner: {r.suggestedOwner} — {r.ownerReason}
              </p>
            </details>
          </div>
        ))}
      </div>
    </main>
  );
}
