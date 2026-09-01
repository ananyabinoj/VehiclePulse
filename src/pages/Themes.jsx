import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import SeverityBadge from "../components/SeverityBadge.jsx";

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
      .then(setReports);
  }, []);

  function setFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadThemes(next);
  }

  const searched = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return reports;
    return reports.filter(
      (r) =>
        r.id.toLowerCase().includes(s) ||
        r.rawText.toLowerCase().includes(s) ||
        r.theme.toLowerCase().includes(s) ||
        r.vehicleModel.toLowerCase().includes(s)
    );
  }, [reports, q]);

  if (!data) return <main className="page page-wide">Loading themes…</main>;

  const st = data.stats || {};

  return (
    <main className="page page-wide">
      <h2>Recurring Themes</h2>
      <p className="lede">What are customers and fleets repeatedly telling us?</p>

      <div className="grid-4">
        <div className="card metric">
          <div className="k">Total Reports</div>
          <div className="v">{st.totalReports}</div>
        </div>
        <div className="card metric">
          <div className="k">Vehicles Affected</div>
          <div className="v">{Number(st.vehiclesAffected || 0).toLocaleString()}</div>
        </div>
        <div className="card metric">
          <div className="k">High/Critical Issues</div>
          <div className="v">{st.highCritical}</div>
        </div>
        <div className="card metric">
          <div className="k">Recurring Themes</div>
          <div className="v">{st.recurringThemes}</div>
        </div>
      </div>

      <div className="formula">
        <strong>MVP heuristic (not an industry standard):</strong> Priority = affected vehicles × severity
        weight (P0=10, P1=5, P2=2, P3=1).
        <div style={{ marginTop: 6 }}>
          This ranking favors problems that affect many vehicles and have meaningful customer or operational
          impact.
        </div>
      </div>

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

      {data.themes.map((t) => (
        <div
          className="card theme-row"
          key={t.id}
          role="button"
          tabIndex={0}
          onClick={() => nav(`/themes/${t.id}`)}
          onKeyDown={(e) => e.key === "Enter" && nav(`/themes/${t.id}`)}
        >
          <div>
            <strong>{t.name}</strong> <SeverityBadge severity={t.severity} />
            <p className="reason">{t.description}</p>
            <div className="meta">
              <span>Affected vehicles: {t.affectedVehicles.toLocaleString()}</span>
              <span>Reports: {t.reportCount}</span>
              <span>Severity: {t.severity}</span>
            </div>
          </div>
          <div className="score">
            {t.priorityScore.toLocaleString()}
            <span>Priority score</span>
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 28 }}>Report list</h2>
      <p className="lede">Search by report ID, keywords, theme, or vehicle model.</p>
      <input
        style={{ width: "100%", maxWidth: 420, marginBottom: 12, padding: "8px 10px", border: "1px solid var(--line-strong)", borderRadius: 4 }}
        placeholder="Search reports…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
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
            {searched.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/themes/${slug(r.theme)}`}>{r.id}</Link>
                </td>
                <td>{r.date}</td>
                <td>{r.vehicleModel}</td>
                <td>{r.theme}</td>
                <td>
                  <SeverityBadge severity={r.severity} />
                </td>
                <td>{r.affectedVehicles}</td>
                <td>{r.triageSummary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
