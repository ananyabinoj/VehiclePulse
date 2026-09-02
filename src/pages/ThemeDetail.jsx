import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import SeverityBadge from "../components/SeverityBadge.jsx";
import RawData from "../components/RawData.jsx";

/** §17/§21 — a missing count is reported as unknown, never as zero and never invented. */
const vehicles = (n) => (n === null || n === undefined ? "Unknown" : Number(n).toLocaleString());

export default function ThemeDetail() {
  const { id } = useParams();
  const [theme, setTheme] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);
  const [rawId, setRawId] = useState(null);
  const [raw, setRaw] = useState(null);

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

  /** §13 — the original imported row, fetched only when a reviewer asks for it. */
  async function toggleRaw(reportId) {
    if (rawId === reportId) {
      setRawId(null);
      setRaw(null);
      return;
    }
    setRawId(reportId);
    setRaw(null);
    const res = await fetch(`/api/reports/${reportId}/raw`);
    setRaw(await res.json());
  }

  if (err) return <main className="page">{err} — <Link to="/themes">Back</Link></main>;
  if (!theme) return <main className="page">Loading…</main>;

  const dist = theme.severityDistribution || {};
  const mix = theme.sourceMix || [];
  const hasReal = mix.some((m) => m.label === "real");

  return (
    <main className="page">
      <p>
        <Link to="/themes">← Recurring Themes</Link>
      </p>
      <div className="sim-head">
        <h2 style={{ margin: 0 }}>{theme.name}</h2>
        <SeverityBadge severity={theme.severity} />
        {mix.map((m) => (
          <span
            key={m.label}
            className={`pill ${m.label === "real" ? "pill-real" : "pill-synthetic"}`}
            title={
              m.label === "real"
                ? "Public NHTSA complaint data — not internal OEM support tickets"
                : "Synthetic demo report"
            }
          >
            {m.label === "real" ? "NHTSA / Public" : "Synthetic"} {m.count}
          </span>
        ))}
      </div>
      <p className="lede" style={{ marginTop: 8 }}>
        {theme.description}
      </p>

      {/* §5 — the theme's own name is an AI-generated field, so it gets a reason too. */}
      {theme.nameBasis && (
        <p className="note" style={{ margin: "-8px 0 18px" }}>
          Named from the corpus: {theme.nameBasis}
          {theme.nameSource === "corpus-label"
            ? " This theme carries a curated label from the seed data."
            : ""}
          {theme.mergedClusters > 1 ? ` ${theme.mergedClusters} clusters were merged into it.` : ""}
        </p>
      )}

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Why it matters</h3>
        <p style={{ margin: 0 }}>{theme.whyItMatters}</p>
      </div>

      <div className="grid-4">
        <div className="card metric">
          <div className="k">Affected vehicles</div>
          <div className="v">{vehicles(theme.affectedVehicles)}</div>
          <div className="s">
            {theme.affectedVehiclesUnknownReports > 0
              ? `${theme.affectedVehiclesUnknownReports} report(s) state no count`
              : `from ${theme.affectedVehiclesKnownReports ?? theme.reportCount} report(s)`}
          </div>
        </div>
        <div className="card metric">
          <div className="k">Priority score</div>
          <div className="v">{Number(theme.priorityScore || 0).toLocaleString()}</div>
          <div className="s">{theme.priorityBasis || "MVP heuristic"}</div>
        </div>
        <div className="card metric">
          <div className="k">Reports</div>
          <div className="v">{theme.reportCount}</div>
          <div className="s">
            {theme.untriagedCount > 0
              ? `${theme.analyzedCount} triaged · ${theme.untriagedCount} untriaged`
              : theme.recurring
                ? "recurring (2 or more)"
                : "one-off so far"}
          </div>
        </div>
        <div className="card metric">
          <div className="k">Peak severity</div>
          <div className="v" style={{ fontSize: 18 }}>
            <SeverityBadge severity={theme.severity} />
          </div>
          <div className="s">highest in the cluster, not an average</div>
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
        {(theme.issueTypes || []).length > 0 && (
          <p className="note" style={{ marginTop: 8 }}>
            Issue types:{" "}
            {theme.issueTypes.map((x) => `${x.label} (${x.count})`).join(", ")}
          </p>
        )}
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
        {(theme.commonTriggers || []).length === 0 ? (
          <p className="note" style={{ margin: 0 }}>
            No trigger has been established across these reports.
          </p>
        ) : (
          theme.commonTriggers.map((x) => (
            <div key={x.label}>
              {x.label} ({x.count})
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Common recovery paths</h3>
        {(theme.commonRecovery || []).length === 0 ? (
          <p className="note" style={{ margin: 0 }}>
            No recovery path is supported by the evidence in these reports.
          </p>
        ) : (
          theme.commonRecovery.map((x) => (
            <div key={x.label}>
              {x.label} ({x.count})
            </div>
          ))
        )}
        {(theme.owners || []).length > 0 && (
          <p className="note" style={{ marginTop: 8 }}>
            Suggested owner{theme.owners.length === 1 ? "" : "s"}: {theme.owners.join(", ")}
          </p>
        )}
      </div>

      <div className="summary-box">
        <h3>Suggested product improvement</h3>
        <p style={{ margin: 0 }}>{theme.productImprovement}</p>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Reports contributing to this theme</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Grouped by{" "}
          {theme.clusteringEngine?.startsWith("openai")
            ? "semantic embedding similarity"
            : "local lexical vector similarity"}
          , then confirmed to share a subsystem. Similar wording is not proof of a duplicate.
        </p>
        {(theme.reports || []).map((r) => {
          const line = [r.vehicleModel, r.softwareVersion, r.component].filter(Boolean).join(" · ");
          return (
            <div key={r.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
              <div className="sim-head">
                <strong>{r.id}</strong>
                <SeverityBadge severity={r.severity} />
                {r.sourceType === "real" && <span className="pill pill-real">NHTSA / Public</span>}
                <span className="note">
                  {line || "no vehicle metadata"} · {vehicles(r.affectedVehicles)} vehicle
                  {r.affectedVehicles === 1 ? "" : "s"}
                </span>
              </div>
              <p className="reason">{r.triageSummary || "Not yet triaged."}</p>
              <details
                className="details"
                open={openId === r.id}
                onToggle={(e) => e.target.open && setOpenId(r.id)}
              >
                <summary>Details</summary>
                <p>
                  <em>Raw:</em> {r.rawText}
                </p>
                <p>
                  Source: {[r.source, r.location, r.date].filter(Boolean).join(" · ") || "unstated"}
                </p>
                <p>Subsystem: {r.subsystem || "Needs review"}</p>
                <p>Severity reason: {r.severityReason || "—"}</p>
                <p>
                  Recovery: {r.recoveryPath || "Unknown"} — {r.recoveryReason || "—"}
                </p>
                <p>
                  Trigger: {r.triggerCondition || "Trigger unclear"} — {r.triggerReason || "—"}
                </p>
                <p>
                  Owner: {r.suggestedOwner || "Needs review"} — {r.ownerReason || "—"}
                </p>
                <p>
                  Affected vehicles: {vehicles(r.affectedVehicles)}
                  {r.affectedVehicleBasis ? ` — ${r.affectedVehicleBasis}` : ""}
                </p>
                {r.hasRawData && (
                  <>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => toggleRaw(r.id)}
                    >
                      {rawId === r.id ? "Hide raw data" : "View raw data"}
                    </button>
                    {rawId === r.id && (
                      <div style={{ marginTop: 8 }}>
                        <RawData raw={raw} />
                      </div>
                    )}
                  </>
                )}
              </details>
            </div>
          );
        })}
      </div>

      {hasReal && (
        <p className="note" style={{ marginTop: 12 }}>
          Reports marked NHTSA / Public are public consumer complaints — one owner and one vehicle each.
          They are not internal OEM support tickets, and they are not fleet-wide counts.
        </p>
      )}
    </main>
  );
}
