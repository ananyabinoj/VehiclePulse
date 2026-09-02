import { Fragment, useEffect, useRef, useState } from "react";
import SeverityBadge from "../components/SeverityBadge.jsx";
import RawData from "../components/RawData.jsx";

const PLACEHOLDER =
  "Example: Customer fleet ops says update campaign 4.2.1 stalls around 60% on the body control module. Only on units that were parked overnight. Their tech cleared it by reflashing at the depot. Third time this month, they are asking whether they should pause the campaign.";

/**
 * Intake — the two ways a report enters the desk (§9).
 *
 * "Paste report" is the original flow and is unchanged in behaviour. "Import CSV/TXT"
 * adds the file path: preview → confirm → normalize → triage in batches. Both live on
 * this page deliberately; the app still has exactly three destinations (§28).
 *
 * `status` is owned by App so the header chip and this page can never disagree about which
 * engine is running or how large the corpus is; `onCorpusChange` re-reads it after an import.
 */
export default function Intake({ status, onCorpusChange }) {
  const [tab, setTab] = useState("paste");

  return (
    <main className="page">
      <h2>Intake</h2>
      <p className="lede">
        Analyze one report, or import a dataset. The desk proposes a triage — it does not replace the engineer.
      </p>

      <div className="tabs" role="radiogroup" aria-label="Intake mode">
        <label className={`tab ${tab === "paste" ? "active" : ""}`}>
          <input
            type="radio"
            name="intake-mode"
            checked={tab === "paste"}
            onChange={() => setTab("paste")}
          />{" "}
          Paste report
        </label>
        <label className={`tab ${tab === "import" ? "active" : ""}`}>
          <input
            type="radio"
            name="intake-mode"
            checked={tab === "import"}
            onChange={() => setTab("import")}
          />{" "}
          Import CSV/TXT
        </label>
      </div>

      {tab === "paste" ? (
        <PastePanel status={status} />
      ) : (
        <ImportPanel status={status} onCorpusChange={onCorpusChange} />
      )}

      <div className="card config-box">
        <strong>Analysis engine</strong>
        <p style={{ margin: "6px 0 0" }}>
          {status ? `${status.engine} — ${status.engineDetail}` : "Checking the server configuration…"}
        </p>
        {status?.demoMode && (
          <p style={{ margin: "6px 0 0" }}>
            For live LLM analysis, put <code>GROQ_API_KEY=gsk-…</code> in a project-root <code>.env</code>{" "}
            (optionally <code>GROQ_MODEL=llama-3.3-70b-versatile</code>) and restart the server. The key stays server-side.
          </p>
        )}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ paste report */

function PastePanel({ status }) {
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
      // §26 — a live failure says the report was not lost, and the text stays in the box.
      if (!res.ok) throw new Error(data.error || "Analyze failed");
      setResult(data);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
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
              <button
                key={ex.id}
                className="btn btn-secondary"
                type="button"
                onClick={() => loadNamed(ex.id)}
                style={{ marginLeft: 6 }}
              >
                {ex.title}
              </button>
            ))}
          </p>
        )}
        {loading && (
          <p className="note" style={{ marginTop: 10 }}>
            {status?.demoMode
              ? "Matching against the corpus and applying the rubric…"
              : `Sending to ${status?.model || "the model"} with the most similar reports as context…`}
          </p>
        )}
        {error && (
          <p className="err" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
      </div>

      {result && <TriageView result={result} />}
    </>
  );
}

/* --------------------------------------------------------------- import CSV/TXT */

function ImportPanel({ status, onCorpusChange }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [busy, setBusy] = useState("");
  const [committed, setCommitted] = useState(null);
  const [batch, setBatch] = useState(null);
  const [batchSize, setBatchSize] = useState(25);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (status?.analyzeBatchSize) setBatchSize(status.analyzeBatchSize);
  }, [status?.analyzeBatchSize]);

  const localFile = status?.localFlatFile;

  function reset() {
    setFile(null);
    setPreview(null);
    setPreviewError(null);
    setCommitted(null);
    setBatch(null);
  }

  /** Preview an uploaded file. descriptionColumn re-runs detection with a manual choice (§26). */
  async function runPreview(f, descriptionColumn) {
    setBusy("preview");
    setPreviewError(null);
    setCommitted(null);
    try {
      const qs = new URLSearchParams({ filename: f.name });
      if (descriptionColumn !== undefined && descriptionColumn !== null) {
        qs.set("descriptionColumn", String(descriptionColumn));
      }
      const res = await fetch(`/api/import/preview?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: await f.text(),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreview(null);
        setPreviewError(data);
      } else {
        setPreview({ ...data, local: false });
      }
    } catch (e) {
      setPreviewError({ error: `We couldn't read that file: ${String(e.message || e)}` });
    } finally {
      setBusy("");
    }
  }

  async function runLocalPreview() {
    setBusy("preview");
    setPreviewError(null);
    setCommitted(null);
    setFile(null);
    try {
      const res = await fetch("/api/import/local-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 2000 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreview(null);
        setPreviewError(data);
      } else {
        setPreview(data);
      }
    } catch (e) {
      setPreviewError({ error: String(e.message || e) });
    } finally {
      setBusy("");
    }
  }

  async function commit() {
    setBusy("commit");
    try {
      let res;
      if (preview.local) {
        res = await fetch("/api/import/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ local: true, limit: preview.rowCount, filename: preview.filename }),
        });
      } else {
        const qs = new URLSearchParams({ filename: file.name });
        if (!preview.descriptionGuessedAccepted && preview.descriptionColumn !== undefined) {
          qs.set("descriptionColumn", String(preview.descriptionColumn));
        }
        res = await fetch(`/api/import/commit?${qs}`, {
          method: "POST",
          headers: { "Content-Type": "text/csv" },
          body: await file.text(),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setPreviewError(data);
      } else {
        setCommitted(data);
        setPreview(null);
        setBatchSize(Math.min(data.suggestedBatch || 25, 25, data.pending));
        onCorpusChange?.();
      }
    } catch (e) {
      setPreviewError({ error: String(e.message || e) });
    } finally {
      setBusy("");
    }
  }

  /**
   * §15 — one report per request so the count is real rather than an animation, and so a
   * long batch can be stopped. Each response reports what is left, and a failed report
   * stays in the corpus flagged instead of being dropped.
   */
  async function runBatch(total) {
    cancelRef.current = false;
    setBatch({ done: 0, total, ok: 0, failed: 0, results: [], running: true, error: null });
    for (let i = 0; i < total; i++) {
      if (cancelRef.current) break;
      let data;
      try {
        const res = await fetch("/api/import/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 1 }),
        });
        data = await res.json();
        if (!res.ok) {
          setBatch((b) => ({ ...b, running: false, error: data.error || "Analysis failed." }));
          return;
        }
      } catch (e) {
        setBatch((b) => ({ ...b, running: false, error: String(e.message || e) }));
        return;
      }
      if (!data.total) break; // queue drained early
      setBatch((b) => ({
        ...b,
        done: b.done + data.total,
        ok: b.ok + data.analyzed,
        failed: b.failed + data.failed,
        results: [...data.results, ...b.results].slice(0, 60),
        remaining: data.remaining,
        mode: data.mode,
      }));
    }
    setBatch((b) => ({ ...b, running: false }));
    onCorpusChange?.();
  }

  async function removeImported() {
    setBusy("delete");
    try {
      await fetch("/api/reports/imported", { method: "DELETE" });
      reset();
      onCorpusChange?.();
    } finally {
      setBusy("");
    }
  }

  const pending = status?.corpus?.pending ?? 0;

  return (
    <>
      <div className="card">
        <strong>Import a complaint dataset</strong>
        <p className="note" style={{ marginTop: 6 }}>
          CSV, TSV or the NHTSA tab-delimited flat file. NHTSA columns (CDESCR, MAKETXT, MODELTXT, COMPDESC,
          ODINO…) are recognized automatically. Nothing is stored until you confirm the preview.
        </p>
        <div className="btn-row">
          <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
            Choose file…
            <input
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  runPreview(f);
                }
                e.target.value = "";
              }}
            />
          </label>
          {localFile?.available && (
            <button className="btn btn-secondary" type="button" onClick={runLocalPreview} disabled={busy === "preview"}>
              Use local {localFile.filename} ({localFile.sizeLabel})
            </button>
          )}
          {(preview || committed || previewError) && (
            <button className="btn btn-secondary" type="button" onClick={reset}>
              Start over
            </button>
          )}
        </div>
        {file && <p className="note" style={{ marginTop: 8 }}>Selected: {file.name}</p>}
        {busy === "preview" && <p className="note" style={{ marginTop: 8 }}>Reading and detecting columns…</p>}
      </div>

      {previewError && <ImportError err={previewError} file={file} onRetry={(col) => file && runPreview(file, col)} />}

      {preview && (
        <PreviewCard
          preview={preview}
          busy={busy}
          onColumnChange={(col) => (preview.local ? null : file && runPreview(file, col))}
          onCommit={commit}
          onCancel={reset}
        />
      )}

      {committed && <CommitSummary c={committed} />}

      {(committed || pending > 0) && (
        <div className="card">
          <strong>Triage imported reports</strong>
          <p className="note" style={{ marginTop: 6 }}>
            {pending > 0
              ? `${pending.toLocaleString()} imported report${pending === 1 ? "" : "s"} ${
                  pending === 1 ? "is" : "are"
                } stored but not yet triaged. Untriaged reports carry no severity, trigger or owner — they are excluded from themes rather than given guessed values.`
              : "Every imported report has been triaged."}
          </p>
          <div className="btn-row" style={{ alignItems: "center" }}>
            <label className="note" htmlFor="bsize">
              Batch size
            </label>
            <input
              id="bsize"
              type="number"
              min="1"
              max="500"
              value={batchSize}
              onChange={(e) => setBatchSize(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              style={{ width: 80, padding: "6px 8px", border: "1px solid var(--line-strong)", borderRadius: 4 }}
            />
            <button
              className="btn"
              type="button"
              disabled={batch?.running || pending === 0}
              onClick={() => runBatch(Math.min(batchSize, pending))}
            >
              {batch?.running ? "Analyzing…" : `Analyze ${Math.min(batchSize, pending)} reports`}
            </button>
            {batch?.running && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                Stop
              </button>
            )}
          </div>
          {batch && <BatchProgress batch={batch} />}
        </div>
      )}

      <ImportedReports
        refreshKey={`${status?.corpus?.total}-${batch?.done ?? 0}-${committed?.datasetId ?? ""}`}
        onAnalyzed={onCorpusChange}
      />

      {(status?.corpus?.real ?? 0) > 0 && (
        <div className="card config-box">
          <strong>Reset</strong>
          <p style={{ margin: "6px 0 0" }}>
            {status.corpus.real.toLocaleString()} imported report(s) in the corpus. Removing them leaves the
            synthetic seed reports untouched.
          </p>
          <div className="btn-row">
            <button className="btn btn-secondary" type="button" onClick={removeImported} disabled={busy === "delete"}>
              {busy === "delete" ? "Removing…" : "Remove imported reports"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** §26 — a parse failure explains what was expected and offers manual column selection. */
function ImportError({ err, file, onRetry }) {
  const [col, setCol] = useState("");
  return (
    <div className="card">
      <p className="err" style={{ margin: 0 }}>
        {err.error}
      </p>
      {err.hint && (
        <p className="note" style={{ marginTop: 6 }}>
          {err.hint}
        </p>
      )}
      {err.lookedIn?.length > 0 && (
        <p className="note" style={{ marginTop: 6 }}>
          Looked in: {err.lookedIn.join(", ")}
        </p>
      )}
      {err.columnOptions?.length > 0 && file && (
        <div className="btn-row" style={{ alignItems: "center" }}>
          <label className="note" htmlFor="mancol">
            Pick the complaint-description column:
          </label>
          <select id="mancol" value={col} onChange={(e) => setCol(e.target.value)}>
            <option value="">Select a column…</option>
            {err.columnOptions.map((c) => (
              <option key={c.index} value={c.index}>
                {c.name} {c.sample ? `— e.g. ${String(c.sample).slice(0, 40)}` : ""}
              </option>
            ))}
          </select>
          <button className="btn" type="button" disabled={col === ""} onClick={() => onRetry(Number(col))}>
            Use this column
          </button>
        </div>
      )}
    </div>
  );
}

/** §11 — row count, what was detected, the first ten rows, then Import / Cancel. */
function PreviewCard({ preview, busy, onColumnChange, onCommit, onCancel }) {
  return (
    <div className="card">
      <div className="preview-head">
        <div>
          <strong>{preview.rowCountLabel}</strong>
          <p className="note" style={{ margin: "4px 0 0" }}>
            {preview.filename ? `${preview.filename} · ` : ""}
            {preview.delimiter}-delimited
            {preview.schema === "nhtsa-flat" ? " · NHTSA flat-file layout" : ""}
            {preview.headerless ? " · no header row" : ""}
            {preview.fileSizeBytes ? ` · ${(preview.fileSizeBytes / 1048576).toFixed(1)} MB on disk` : ""}
          </p>
        </div>
        <span className="pill pill-real">{preview.sourceLabel}</span>
      </div>

      <p className="note" style={{ marginTop: 8 }}>
        {preview.sourceNote}
      </p>
      {preview.headerNote && (
        <p className="note" style={{ marginTop: 6 }}>
          {preview.headerNote}
        </p>
      )}
      {preview.truncationNote && (
        <p className="note" style={{ marginTop: 6 }}>
          {preview.truncationNote}
        </p>
      )}

      <h4 className="sub">Identified columns</h4>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Column</th>
              <th>Example value</th>
            </tr>
          </thead>
          <tbody>
            {preview.detected.map((d) => (
              <tr key={d.field}>
                <td>
                  <strong>{d.label}</strong>
                </td>
                <td className="mono">
                  {d.columnName} <span className="note">(col {d.columnIndex})</span>
                </td>
                <td>{d.sample || <span className="note">empty in the first rows</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="btn-row" style={{ alignItems: "center" }}>
        <label className="note" htmlFor="descsel">
          Complaint description column:
        </label>
        <select
          id="descsel"
          value={preview.descriptionColumn ?? ""}
          disabled={preview.local}
          onChange={(e) => onColumnChange(Number(e.target.value))}
        >
          {preview.columnOptions.map((c) => (
            <option key={c.index} value={c.index}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {preview.descriptionNote && (
        <p className="note" style={{ marginTop: 6 }}>
          {preview.descriptionNote}
        </p>
      )}

      <h4 className="sub">First {preview.previewCount} rows</h4>
      <div className="scroll-x">
        <table className="table table-tight">
          <thead>
            <tr>
              {preview.headers.map((h, i) => (
                <th key={i} className={i === preview.descriptionColumn ? "col-key" : ""}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.sampleRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} className={ci === preview.descriptionColumn ? "col-key" : ""}>
                    {cell.length > 90 ? `${cell.slice(0, 89)}…` : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="btn-row">
        <button className="btn" type="button" onClick={onCommit} disabled={busy === "commit"}>
          {busy === "commit" ? "Importing…" : `Import ${preview.rowCount.toLocaleString()} rows`}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={busy === "commit"}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** §14/§21 — rows read, complaints, and reports are three different numbers. */
function CommitSummary({ c }) {
  return (
    <div className="card">
      <div className="preview-head">
        <strong>Imported</strong>
        <span className="pill pill-real">{c.sourceLabel}</span>
      </div>
      <div className="kv">
        <div>
          <span className="k">Rows read</span>
          <span className="v">{c.rowsRead.toLocaleString()}</span>
        </div>
        <div>
          <span className="k">Distinct complaints</span>
          <span className="v">{c.distinctComplaints.toLocaleString()}</span>
        </div>
        <div>
          <span className="k">Reports stored</span>
          <span className="v">{c.imported.toLocaleString()}</span>
        </div>
        <div>
          <span className="k">Rows without a description</span>
          <span className="v">{c.rowsSkippedNoDescription.toLocaleString()}</span>
        </div>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        {c.dedupeNote}
      </p>
      <p className="note" style={{ marginTop: 6 }}>
        {c.sourceNote}
      </p>
    </div>
  );
}

function BatchProgress({ batch }) {
  const pct = batch.total ? Math.round((batch.done / batch.total) * 100) : 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="progress-row">
        <strong>
          {batch.running
            ? `Analyzing ${Math.min(batch.done + 1, batch.total)} of ${batch.total} reports…`
            : `Analyzed ${batch.done} of ${batch.total} reports`}
        </strong>
        <span className="note">
          {batch.ok} triaged
          {batch.failed ? ` · ${batch.failed} failed` : ""}
          {batch.mode ? ` · ${batch.mode === "live" ? "live analysis" : "Demo Mode"}` : ""}
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      {batch.error && (
        <p className="err" style={{ marginTop: 8 }}>
          {batch.error}
        </p>
      )}
      {batch.failed > 0 && !batch.error && (
        <p className="note" style={{ marginTop: 8 }}>
          Failed reports are still in the corpus, flagged “Not yet triaged” rather than given guessed values.
        </p>
      )}
      {batch.results.length > 0 && (
        <div className="scroll-x" style={{ marginTop: 8, maxHeight: 220, overflowY: "auto" }}>
          <table className="table table-tight">
            <tbody>
              {batch.results.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{r.ok ? <SeverityBadge severity={r.severity} /> : <span className="err">failed</span>}</td>
                  <td>{r.ok ? r.subsystem : r.error}</td>
                  <td className="note">{r.ok ? r.issueType : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The imported corpus, with the original source row behind each report (§13). */
function ImportedReports({ refreshKey, onAnalyzed }) {
  const [reports, setReports] = useState([]);
  const [open, setOpen] = useState(null);
  const [raw, setRaw] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const LIMIT = 25;

  useEffect(() => {
    fetch("/api/reports?sourceType=real")
      .then((r) => r.json())
      .then((rs) => setReports(Array.isArray(rs) ? rs.filter((r) => r.sourceType === "real") : []))
      .catch(() => setReports([]));
  }, [refreshKey]);

  async function analyzeOne(id) {
    setBusyId(id);
    try {
      await fetch(`/api/reports/${id}/analyze`, { method: "POST" });
      onAnalyzed?.();
      const rs = await fetch("/api/reports?sourceType=real").then((r) => r.json());
      setReports(Array.isArray(rs) ? rs.filter((r) => r.sourceType === "real") : []);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRaw(id) {
    if (open === id) {
      setOpen(null);
      setRaw(null);
      return;
    }
    setOpen(id);
    setRaw(null);
    const res = await fetch(`/api/reports/${id}/raw`);
    setRaw(await res.json());
  }

  if (!reports.length) return null;

  return (
    <div className="card">
      <strong>Imported reports ({reports.length.toLocaleString()})</strong>
      <p className="note" style={{ marginTop: 6 }}>
        Public NHTSA complaints, available to similarity search and to Themes once triaged. Showing the first{" "}
        {Math.min(LIMIT, reports.length)}.
      </p>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Vehicle</th>
              <th>Component (as filed)</th>
              <th>Severity</th>
              <th>Subsystem</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.slice(0, LIMIT).map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td className="mono">{r.id}</td>
                  {/* vehicleModel is already "MAKE MODEL" for imports, so make is not repeated. */}
                  <td>{[r.modelYear, r.vehicleModel].filter(Boolean).join(" ") || "—"}</td>
                  <td>{r.component || "—"}</td>
                  <td>
                    {r.analysisStatus === "analyzed" && r.severity ? (
                      <SeverityBadge severity={r.severity} />
                    ) : (
                      <span className="pill pill-pending">
                        {r.analysisStatus === "failed" ? "Analysis failed" : "Not yet triaged"}
                      </span>
                    )}
                  </td>
                  <td>{r.subsystem || <span className="note">—</span>}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => toggleRaw(r.id)}>
                      {open === r.id ? "Hide raw data" : "View raw data"}
                    </button>
                    {r.analysisStatus !== "analyzed" && (
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => analyzeOne(r.id)}
                        style={{ marginLeft: 6 }}
                      >
                        {busyId === r.id ? "Analyzing…" : "Analyze"}
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={6}>
                      <RawData raw={raw} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- triage view */

function TriageView({ result }) {
  const t = result.triage || {};
  const sim = result.similarity || {};
  return (
    <section style={{ marginTop: 16 }}>
      <p className="ai-label">
        {result.analysisLabel || "AI-assisted"}
        {result.model ? ` · ${result.model}` : ""}
        {t.source ? ` · source: ${t.source}` : ""}
        {" · "}
        {result.disclaimer || "AI-assisted — review before escalation."}
      </p>

      {result.notice && <p className="note">{result.notice}</p>}

      <div className="summary-box">
        <h3>Triage recommendation</h3>
        <p style={{ margin: 0 }}>{t.summary}</p>
      </div>

      <FieldCard title="Affected subsystem" value={t.subsystem} reason={t.subsystem_reason} />
      <FieldCard
        title="Severity"
        value={<SeverityBadge severity={t.severity} engine={t.severity_engine || result.analysisLabel} />}
        reason={
          t.source_fields_used?.length
            ? `${t.severity_reason} Fields used: ${t.source_fields_used.join(", ")}.`
            : t.severity_reason
        }
      />
      <FieldCard title="Issue type" value={t.issue_type || "Bug"} reason={
        t.issue_type === "Enhancement"
          ? "Read as a request for a capability that does not exist yet, not a defect report."
          : "Read as something that should work and is not working."
      } />
      <FieldCard title="Recovery path" value={t.recovery_path} reason={t.recovery_reason} />
      <FieldCard title="Trigger condition" value={t.trigger_condition} reason={t.trigger_reason} />
      <FieldCard title="Suggested owner" value={t.suggested_owner} reason={t.owner_reason} />
      <FieldCard
        title="Affected vehicles"
        value={
          t.affected_vehicle_count === null || t.affected_vehicle_count === undefined
            ? "Unknown"
            : t.affected_vehicle_count.toLocaleString()
        }
        reason={
          t.affected_vehicle_basis ||
          "The report does not state how many vehicles are affected, so no number is claimed."
        }
      />

      <div className="card">
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Similar reports</h3>
        <p className="note" style={{ marginTop: 0 }}>
          {result.analysisSource === "llm"
            ? "The model compared this report to a shortlist of existing summaries."
            : "Lexical overlap in Demo Mode — not an embedding search."}{" "}
          A high score is not a confirmed duplicate.
        </p>
        {sim.note && (
          <p className="note" style={{ marginTop: 4 }}>
            {sim.note}
          </p>
        )}
        {result.noStrongDuplicates || !result.similar?.length ? (
          <p style={{ marginBottom: 0 }}>
            No report in the corpus is close enough to show. That is a real answer, not an empty list.
          </p>
        ) : (
          result.similar.map((s) => (
            <div key={s.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="sim-head">
                <strong>
                  {s.id} — {s.similarity}% similar
                </strong>
                <span className="pill">{s.relation}</span>
                {s.severity && <SeverityBadge severity={s.severity} />}
                {s.sourceType === "real" && <span className="pill pill-real">NHTSA / Public</span>}
              </div>
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
      <div style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {title}
      </div>
      <div style={{ marginTop: 4, fontSize: 17, fontWeight: 650 }}>{value}</div>
      <p className="reason">
        <strong>Reason:</strong> {reason}
      </p>
    </div>
  );
}
