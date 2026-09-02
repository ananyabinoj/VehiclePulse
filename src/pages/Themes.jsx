import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import SeverityBadge from "../components/SeverityBadge.jsx";

/** §17/§21 — a missing count is reported as unknown, never as zero and never invented. */
const vehicles = (n) => (n === null || n === undefined ? "Unknown" : Number(n).toLocaleString());

const REPORT_ROWS = 100;

export default function Themes() {
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState({});
  const [q, setQ] = useState("");
  const [reports, setReports] = useState([]);
  const [filterOpts, setFilterOpts] = useState(null);
  const nav = useNavigate();

  function loadThemes(next = filters) {
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => {
      if (v) p.set(k, v);
    });
    fetch(`/api/themes?${p}`)
      .then((r) => r.json())
      .then(setData);
  }

  useEffect(() => {
    loadThemes();
    fetch("/api/filters")
      .then((r) => r.json())
      .then(setFilterOpts);
    fetch("/api/reports")
      .then((r) => r.json())
      .then((rs) => setReports(Array.isArray(rs) ? rs : []));
  }, []);

  function setFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadThemes(next);
  }

  /**
   * Imported reports have no theme, severity or summary until they are triaged, so every
   * field here is treated as possibly absent rather than assumed present.
   */
  const searched = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return reports;
    const has = (v) => String(v || "").toLowerCase().includes(s);
    return reports.filter(
      (r) => has(r.id) || has(r.rawText) || has(r.theme) || has(r.vehicleModel) || has(r.component)
    );
  }, [reports, q]);

  if (!data) return <main className="page page-wide">Loading themes…</main>;

  const st = data.stats || {};
  const cl = data.clustering || {};
  const un = data.untriaged || {};
  const themes = Array.isArray(data.themes) ? data.themes : [];

  /**
   * The server disambiguates colliding theme ids and truncates long ones, so a slug computed
   * here can miss. Reading the real ids off the payload keeps the report-list links honest;
   * slug() is only the fallback for a theme the current filters have hidden.
   */
  const idByName = new Map(themes.map((t) => [t.name, t.id]));

  return (
    <main className="page page-wide">
      <h2>Recurring Themes</h2>
      <p className="lede">What are customers and fleets repeatedly telling us?</p>

      <div className="grid-4">
        <div className="card metric">
          <div className="k">Reports in corpus</div>
          <div className="v">{Number(st.totalReports || 0).toLocaleString()}</div>
          <div className="s">{Number(st.themedReports || 0).toLocaleString()} triaged and grouped</div>
        </div>
        <div className="card metric">
          <div className="k">Vehicles Affected</div>
          <div className="v">{Number(st.vehiclesAffected || 0).toLocaleString()}</div>
          <div className="s">
            {st.vehiclesUnknownReports
              ? `${Number(st.vehiclesUnknownReports).toLocaleString()} report(s) do not state a count`
              : "counted only where a report states one"}
          </div>
        </div>
        <div className="card metric">
          <div className="k">High/Critical Issues</div>
          <div className="v">{st.highCritical ?? 0}</div>
          <div className="s">themes peaking at P0 or P1</div>
        </div>
        <div className="card metric">
          <div className="k">Recurring Themes</div>
          <div className="v">{st.recurringThemes ?? 0}</div>
          <div className="s">of {st.totalThemes ?? 0} total ({"≥"}2 reports each)</div>
        </div>
      </div>

      <div className="formula">
        <strong>MVP heuristic (not an industry standard):</strong>{" "}
        {data.heuristic ||
          "Priority = affected vehicles × severity weight (P0=10, P1=5, P2=2, P3=1)."}
        <div style={{ marginTop: 6 }}>
          Reports and vehicles are different numbers: one report can represent one vehicle or a whole
          fleet, so the score uses the vehicle count a report actually states.
        </div>
      </div>

      {/* §19 — themes come from the corpus, and the page says which engine grouped them. */}
      <p className="note" style={{ margin: "0 0 14px" }}>
        Grouped from {Number(st.themedReports || 0).toLocaleString()} triaged report
        {st.themedReports === 1 ? "" : "s"}
        {cl.engine === "llm"
          ? cl.cached
            ? " using a cached LLM clustering (recomputed only when the corpus changes)."
            : " using one LLM clustering pass, now cached."
          : " from stored theme labels (Demo Mode)."}{" "}
        Priority uses the MVP heuristic: affected vehicles × severity weight.
        {cl.error ? ` Clustering note: ${cl.error}` : ""}
      </p>

      {un.count > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="preview-head">
            <strong>{Number(un.count).toLocaleString()} report(s) not yet triaged</strong>
            <span className="pill pill-pending">Excluded from themes</span>
          </div>
          <p className="note" style={{ marginTop: 6 }}>
            These are imported and searchable, but they carry no severity, trigger or owner. They are
            left out of the themes above rather than clustered on guessed values.
            {un.failed ? ` ${Number(un.failed).toLocaleString()} failed analysis and can be retried.` : ""}{" "}
            Triage them from <Link to="/">Intake → Import CSV/TXT</Link>.
          </p>
        </div>
      )}

      <div className="filters">
        <select value={filters.severity || ""} onChange={(e) => setFilter("severity", e.target.value)}>
          <option value="">All severities</option>
          {(filterOpts?.severities || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.subsystem || ""} onChange={(e) => setFilter("subsystem", e.target.value)}>
          <option value="">All subsystems</option>
          {(filterOpts?.subsystems || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.model || ""} onChange={(e) => setFilter("model", e.target.value)}>
          <option value="">All models</option>
          {(filterOpts?.models || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.version || ""} onChange={(e) => setFilter("version", e.target.value)}>
          <option value="">All software versions</option>
          {(filterOpts?.versions || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.owner || ""} onChange={(e) => setFilter("owner", e.target.value)}>
          <option value="">All owners</option>
          {(filterOpts?.owners || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {themes.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }}>
            No theme matches these filters. That is a real answer — nothing has been invented to fill
            the page.
          </p>
        </div>
      )}

      {themes.map((t) => (
        <div
          className="card theme-row"
          key={t.id}
          role="button"
          tabIndex={0}
          onClick={() => nav(`/themes/${t.id}`)}
          onKeyDown={(e) => e.key === "Enter" && nav(`/themes/${t.id}`)}
        >
          <div>
            <div className="sim-head">
              <strong>{t.name}</strong>
              <SeverityBadge severity={t.severity} />
              {(t.sourceMix || []).map((m) => (
                <span
                  key={m.label}
                  className={`pill ${m.label === "real" ? "pill-real" : "pill-synthetic"}`}
                  title={
                    m.label === "real"
                      ? "Public NHTSA complaint data — not internal OEM tickets"
                      : "Synthetic demo report"
                  }
                >
                  {m.label === "real" ? "NHTSA / Public" : "Synthetic"} {m.count}
                </span>
              ))}
            </div>
            <p className="reason">{t.description}</p>
            <div className="meta">
              <span>Affected vehicles: {vehicles(t.affectedVehicles)}</span>
              <span>Reports: {t.reportCount}</span>
              {t.untriagedCount > 0 && <span>{t.untriagedCount} untriaged</span>}
              <span>Peak severity: {t.severity}</span>
              {t.commonTriggers?.[0] && <span>Trigger: {t.commonTriggers[0].label}</span>}
            </div>
          </div>
          <div className="score">
            {Number(t.priorityScore || 0).toLocaleString()}
            <span>Priority score</span>
            {t.priorityBasis && (
              <span className="note" style={{ fontWeight: 400 }}>
                {t.priorityBasis}
              </span>
            )}
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 28 }}>Report list</h2>
      <p className="lede">Search by report ID, keywords, theme, vehicle model, or filed component.</p>
      <input
        style={{ width: "100%", maxWidth: 420, marginBottom: 12, padding: "8px 10px", border: "1px solid var(--line-strong)", borderRadius: 4 }}
        placeholder="Search reports…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <p className="note" style={{ margin: "0 0 8px" }}>
        {searched.length.toLocaleString()} matching report{searched.length === 1 ? "" : "s"}
        {searched.length > REPORT_ROWS ? ` · showing the first ${REPORT_ROWS}` : ""}
      </p>
      <div className="card" style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Date</th>
              <th>Model</th>
              <th>Theme</th>
              <th>Sev</th>
              <th>Vehicles</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {searched.slice(0, REPORT_ROWS).map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  {r.theme ? (
                    <Link to={`/themes/${idByName.get(r.theme) || slug(r.theme)}`}>{r.id}</Link>
                  ) : (
                    r.id
                  )}
                  {r.sourceType === "real" && (
                    <span className="pill pill-real" style={{ marginLeft: 6 }} title="Public NHTSA complaint">
                      Public
                    </span>
                  )}
                </td>
                <td>{r.date || "—"}</td>
                <td>{r.vehicleModel || "—"}</td>
                <td>{r.theme || <span className="note">not yet grouped</span>}</td>
                <td>
                  {r.analysisStatus === "analyzed" && r.severity ? (
                    <SeverityBadge severity={r.severity} />
                  ) : (
                    <span className="pill pill-pending">
                      {r.analysisStatus === "failed" ? "Failed" : "Untriaged"}
                    </span>
                  )}
                </td>
                <td>{vehicles(r.affectedVehicles)}</td>
                <td>
                  {r.triageSummary || (
                    <span className="note">
                      Not yet triaged — {(r.rawText || "").slice(0, 90)}
                      {(r.rawText || "").length > 90 ? "…" : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/** Mirrors the server's id derivation, including its 60-character cap, so the fallback matches. */
function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "theme"
  );
}
