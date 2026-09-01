import { useEffect, useState } from "react";
import SeverityBadge from "../components/SeverityBadge.jsx";

const PLACEHOLDER =
  "Example: Customer fleet ops says update campaign 4.2.1 stalls around 60% on the body control module. Only on units that were parked overnight. Their tech cleared it by reflashing at the depot. Third time this month, they are asking whether they should pause the campaign.";

export default function Intake({ mode }) {
  const [text, setText] = useState("");
  const [examples, setExamples] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch("/api/demo-examples")
      .then((r) => r.json())
      .then(setExamples)
      .catch(() => {});
  }, []);

  function loadExample() {
    const ex = examples[0];
    setText(ex?.text || PLACEHOLDER.replace(/^Example:\s*/, ""));
    setResult(null);
    setError("");
  }

  function loadNamed(id) {
    const ex = examples.find((e) => e.id === id);
    if (ex) {
      setText(ex.text);
      setResult(null);
      setError("");
    }
  }

  async function analyze() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analyze failed");
      setResult(data);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <h2>Intake</h2>
      <p className="lede">Paste a raw field report. The desk proposes a triage — it does not replace the engineer.</p>

      <div className="card">
        <label htmlFor="raw">
          <strong>Paste raw support report</strong>
        </label>
        <textarea
          id="raw"
          className="report-box"
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="btn-row">
          <button className="btn" type="button" onClick={analyze} disabled={loading || !text.trim()}>
            {loading ? "Analyzing…" : "Analyze report"}
          </button>
          <button className="btn btn-secondary" type="button" onClick={loadExample}>
            Load example report
          </button>
        </div>
        {examples.length > 1 && (
          <p className="meta" style={{ marginTop: 10 }}>
            More demo examples:
            {examples.map((ex) => (
              <button key={ex.id} className="btn btn-secondary" type="button" onClick={() => loadNamed(ex.id)} style={{ marginLeft: 6 }}>
                {ex.title}
              </button>
            ))}
          </p>
        )}
        {error && <p className="err">{error}</p>}
      </div>

      {result && <TriageView result={result} />}

      <div className="card config-box">
        <strong>LLM configuration</strong>
        <p style={{ margin: "6px 0 0" }}>
          {mode?.hint ||
            "Without a key, VehiclePulse stays in Demo Mode: seed reports, themes, and canned examples still work. For live classification, create a project-root "}
          <code>.env</code> with <code>OPENAI_API_KEY=sk-...</code> (optional <code>OPENAI_MODEL=gpt-4o-mini</code>) and restart.
        </p>
      </div>
    </main>
  );
}

function TriageView({ result }) {
  const t = result.triage || {};
  return (
    <section style={{ marginTop: 16 }}>
      <p className="ai-label">
        AI-assisted — review before escalation
        {t.source ? ` · source: ${t.source}` : ""}
        {result.demoMode ? " · Demo Mode" : ""}
      </p>

      <div className="summary-box">
        <h3>Triage recommendation</h3>
        <p style={{ margin: 0 }}>{t.summary}</p>
      </div>

      <FieldCard title="Affected subsystem" value={t.subsystem} reason={t.subsystem_reason} />
      <FieldCard
        title="Severity"
        value={<SeverityBadge severity={t.severity} />}
        reason={t.severity_reason}
      />
      <FieldCard title="Recovery path" value={t.recovery_path} reason={t.recovery_reason} />
      <FieldCard
        title="Trigger condition"
        value={t.trigger_condition === "Unclear" ? "Trigger: Unclear" : t.trigger_condition}
        reason={t.trigger_reason}
      />
      <FieldCard title="Suggested owner" value={t.suggested_owner} reason={t.owner_reason} />

      <div className="card">
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Duplicate / Similar reports</h3>
        {result.noStrongDuplicates || !result.similar?.length ? (
          <p style={{ margin: 0 }}>No strong duplicates found</p>
        ) : (
          result.similar.map((s) => (
            <div key={s.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <strong>
                {s.id} — {s.similarity}% similar
              </strong>
              <p className="reason" style={{ marginTop: 4 }}>
                {s.shortDescription}
              </p>
              <p className="reason">Why it appears similar: {s.reason}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function FieldCard({ title, value, reason }) {
  return (
    <div className="card">
      <div style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 17, fontWeight: 650 }}>{value}</div>
      <p className="reason">
        <strong>Reason:</strong> {reason}
      </p>
    </div>
  );
}

