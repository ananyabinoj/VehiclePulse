/**
 * index.js — VehiclePulse API.
 *
 * The OpenAI key is read from process.env here and NEVER sent to the browser (§2/§29).
 * /api/status reports only whether a key is present, never any part of its value.
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  initDb, listReports, getReport, searchReports, getRawData, corpusStats,
  pendingReports, insertReports, saveAnalysis, markAnalysisFailed, nextReportId,
  insertDataset, listDatasets, deleteDataset, deleteAllImported, persist,
} from "./db.js";
import { analyzeReport, LiveAnalysisError, DEFAULT_MODEL } from "./analyze.js";
import { findSimilarReports, pickCandidateSummaries } from "./similarity.js";
import { buildThemes, dashboardStats, invalidateThemeCache } from "./themes.js";
import { DEMO_EXAMPLES } from "./demoExamples.js";
import { SEVERITY_LABELS, SEVERITY_WEIGHTS } from "./seed.js";
import {
  parseUpload, normalizeReports, buildAnalysisText, streamFlatFile, ImportError,
} from "./nhtsa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const apiKey = () => process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || null;
const isDemo = () => !apiKey();
const modelName = () => process.env.GROQ_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL;

/** How many imported reports one batch triages by default (§15). */
const ANALYZE_BATCH = Math.max(1, Number(process.env.ANALYZE_BATCH) || 25);
const PREVIEW_ROWS = 10;
/** Guardrail so a stray click can't spend real money on thousands of reports. */
const ANALYZE_MAX = 500;

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));
// Uploads arrive as raw text so a 40 MB CSV never has to be JSON-escaped (§10).
app.use("/api/import", express.text({ limit: "80mb", type: ["text/*", "application/csv", "application/octet-stream"] }));

/* ------------------------------------------------------------------ meta routes */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, demoMode: isDemo() });
});

app.get("/api/mode", (_req, res) => {
  res.json({
    demoMode: isDemo(),
    model: modelName(),
    hint: isDemo()
      ? "Demo Mode — pre-generated analysis (no OPENAI_API_KEY). Seed data, themes, and example analyses still work."
      : "Live LLM analysis is enabled.",
  });
});

/**
 * §25 — the small engine-status area. Deliberately exposes presence only:
 * no key, no prefix, no length. `keyConfigured` is a boolean and nothing more.
 */
app.get("/api/status", (_req, res) => {
  res.json({
    demoMode: isDemo(),
    keyConfigured: !isDemo(),
    engine: isDemo() ? "Demo Mode" : "Live LLM",
    engineDetail: isDemo()
      ? "Demo Mode — pre-generated analysis. No model calls are made."
      : `Live LLM via Groq ${modelName()}.`,
    analysisLabel: isDemo() ? "Demo Mode — pre-generated analysis" : "Live LLM — review before escalation",
    model: isDemo() ? null : modelName(),
    analyzeBatchSize: ANALYZE_BATCH,
    corpus: corpusStats(),
    datasets: listDatasets(),
    localFlatFile: publicFlatFileStatus(),
  });
});

app.get("/api/demo-examples", (_req, res) => {
  res.json(DEMO_EXAMPLES.map(({ id, title, text }) => ({ id, title, text })));
});

/* --------------------------------------------------------------- report routes */

app.get("/api/reports", (req, res) => {
  const { q, theme, model, sourceType, analysisStatus } = req.query;
  let rows = q || theme || model ? searchReports({ q, theme, model }) : listReports();
  if (sourceType) rows = rows.filter((r) => r.sourceType === sourceType);
  if (analysisStatus) rows = rows.filter((r) => (r.analysisStatus || "analyzed") === analysisStatus);
  res.json(rows);
});

app.get("/api/reports/:id", (req, res) => {
  const row = getReport(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

/** §13 — the untouched original row(s) behind an imported report. */
app.get("/api/reports/:id/raw", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  const raw = getRawData(req.params.id);
  if (!raw) {
    return res.json({
      id: report.id,
      available: false,
      note: "This is a seed/synthetic report, so there is no imported source row behind it.",
    });
  }
  res.json({ id: report.id, available: true, sourceType: report.sourceType, source: report.source, ...raw });
});

/** Triage (or re-triage) one stored report. */
app.post("/api/reports/:id/analyze", async (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  try {
    const result = await analyzeStored(report);
    res.json({ ...envelope(result.triage, result.similar), report: getReport(req.params.id) });
  } catch (e) {
    console.error("[VehiclePulse] analyze stored report failed:", e);
    markAnalysisFailed(report.id);
    persist();
    res.status(502).json({ error: "Live analysis unavailable, showing rule-based result", recoverable: true });
  }
});

app.get("/api/filters", (_req, res) => {
  const reports = listReports();
  const uniq = (fn) => [...new Set(reports.map(fn).filter(Boolean))].sort();
  res.json({
    severities: ["P0", "P1", "P2", "P3"],
    subsystems: uniq((r) => r.subsystem),
    models: uniq((r) => r.vehicleModel),
    versions: uniq((r) => r.softwareVersion),
    owners: uniq((r) => r.suggestedOwner),
    themes: uniq((r) => r.theme),
    sourceTypes: uniq((r) => r.sourceType),
  });
});

/* ---------------------------------------------------------------- theme routes */

/**
 * Themes are clustered from the live corpus on every request. buildThemes is async and
 * returns an envelope, so both the list and detail routes await it.
 *
 * Filters are applied to a theme's membership, not to the clustering input — clustering
 * the filtered subset would silently change which themes exist.
 */
app.get("/api/themes", async (req, res) => {
  try {
    const built = await buildThemes(listReports(), { apiKey: apiKey() });
    const stats = dashboardStats(listReports(), built.themes);

    let themes = built.themes;
    const { severity, subsystem, model, version, owner, sourceType } = req.query;
    if (severity || subsystem || model || version || owner || sourceType) {
      themes = themes
        .map((t) => {
          const filtered = t.reports.filter((r) => {
            if (severity && r.severity !== severity) return false;
            if (subsystem && r.subsystem !== subsystem) return false;
            if (model && r.vehicleModel !== model) return false;
            if (version && r.softwareVersion !== version) return false;
            if (owner && r.suggestedOwner !== owner) return false;
            if (sourceType && r.sourceType !== sourceType) return false;
            return true;
          });
          if (!filtered.length) return null;
          return {
            ...t,
            reports: filtered,
            reportIds: filtered.map((r) => r.id),
            reportCount: filtered.length,
            filtered: filtered.length !== t.reports.length,
          };
        })
        .filter(Boolean);
    }

    res.json({
      stats,
      heuristic:
        "Priority = affected vehicles × severity weight (P0=10, P1=5, P2=2, P3=1). This is VehiclePulse's MVP prioritization heuristic, not an industry standard.",
      weights: SEVERITY_WEIGHTS,
      // Reports held back from theming because they carry no triage yet (§17).
      untriaged: built.untriaged,
      clustering: {
        engine: built.engine,
        degraded: false,
        error: built.error || null,
        cached: Boolean(built.cached),
        note: built.engine === "llm"
          ? "Themes clustered in one LLM pass and cached until the corpus changes."
          : "Themes grouped from stored labels (Demo Mode). MVP heuristic: priority = affected vehicles × severity weight.",
      },
      themes: themes.map(stripReports),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/themes/:id", async (req, res) => {
  try {
    const built = await buildThemes(listReports(), { apiKey: apiKey() });
    const theme = built.themes.find((t) => t.id === req.params.id);
    if (!theme) return res.status(404).json({ error: "Not found" });
    res.json({ ...theme, weights: SEVERITY_WEIGHTS, clusteringEngine: built.engine });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* --------------------------------------------------------------- analyze route */

app.post("/api/analyze", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Paste a report first." });

  const corpus = listReports();
  try {
    const candidates = pickCandidateSummaries(text, corpus, { limit: 15 });
    const triage = await analyzeReport(text, {
      apiKey: apiKey(),
      model: process.env.GROQ_MODEL || process.env.OPENAI_MODEL,
      candidates,
      metadata: {
        sourceType: req.body?.sourceType || "synthetic",
        crash: req.body?.crash,
        fire: req.body?.fire,
        injured: req.body?.injured,
        deaths: req.body?.deaths,
        raw_complaint: text,
      },
    });
    const sim = await resolveSimilar(text, triage, candidates, corpus);
    res.json(envelope(triage, sim));
  } catch (e) {
    console.error("[VehiclePulse] /api/analyze failed:", e);
    res.status(502).json({ error: "Live analysis unavailable, showing rule-based result", recoverable: true });
  }
});

/* ---------------------------------------------------------------- import: preview */

/**
 * §11 — parse locally and return a preview. Nothing is stored and nothing is sent to
 * the LLM at this stage (§12).
 */
app.post("/api/import/preview", (req, res) => {
  const { text, descriptionColumn } = uploadBody(req);
  if (!text.trim()) return res.status(400).json({ error: "The uploaded file was empty." });
  try {
    res.json(previewPayload(parseUpload(text, { descriptionColumn }), { filename: req.query.filename }));
  } catch (e) {
    res.status(400).json(importFailure(e, text));
  }
});

/** Preview the local NHTSA flat file without uploading 1.6 GB through the browser. */
app.post("/api/import/local-preview", async (req, res) => {
  const status = flatFileStatus();
  if (!status.available) {
    return res.status(404).json({
      error: "No local NHTSA file found.",
      lookedIn: status.searched,
      hint: "Place FLAT_CMPL.txt (or nhtsa_sample.csv) in the data/ folder, or upload a CSV instead.",
    });
  }
  try {
    const limit = clamp(Number(req.body?.limit) || 2000, 50, 20000);
    const parsed = await readLocal(status, limit);
    const truncated = Boolean(parsed.truncated) || parsed.rows.length >= limit;
    res.json({
      ...previewPayload(parsed, { filename: status.filename }),
      local: true,
      fileSizeBytes: parsed.fileSize ?? status.sizeBytes,
      truncated,
      truncationNote: truncated
        ? `Read the first ${parsed.rows.length.toLocaleString()} usable rows of a ${status.sizeLabel} file. The rest of the file was not loaded.`
        : null,
    });
  } catch (e) {
    res.status(400).json(importFailure(e, ""));
  }
});

/* ----------------------------------------------------------------- import: commit */

/**
 * §13/§14 — normalize, collapse rows sharing an ODINO into one report, and store.
 * Reports land with analysis_status = 'pending': visible immediately, but with no
 * invented triage values (§17).
 */
app.post("/api/import/commit", async (req, res) => {
  const { text, descriptionColumn, filename, limit, local } = uploadBody(req);
  try {
    const rowLimit = limit ? clamp(Number(limit), 1, 200000) : Infinity;
    const parsed = local
      ? await localParsed(rowLimit === Infinity ? 2000 : rowLimit)
      : parseUpload(text, { descriptionColumn, limit: rowLimit });

    const datasetId = `ds-${Date.now().toString(36)}`;
    const idFactory = nextReportId("R");
    const { reports, stats } = normalizeReports(parsed, { datasetId, idFactory });

    if (!reports.length) {
      return res.status(400).json({
        error: "No usable reports were found — every row was missing a complaint description.",
        code: "NO_ROWS",
        stats,
      });
    }

    const inserted = insertReports(reports);
    insertDataset({
      id: datasetId,
      filename: filename || (local ? flatFileStatus().filename : "upload.csv"),
      sourceType: "real",
      rowCount: stats.rowsSeen,
      reportCount: inserted,
      mapping: parsed.mapping,
    });
    persist(true);
    invalidateThemeCache();

    res.json({
      datasetId,
      imported: inserted,
      // §21 — these are three different numbers and the UI must be able to say so.
      rowsRead: stats.rowsSeen,
      rowsSkippedNoDescription: stats.rowsSkippedNoDescription,
      distinctComplaints: stats.distinctComplaints,
      multiComponentComplaints: stats.multiComponentComplaints,
      dedupeNote:
        stats.multiComponentComplaints > 0
          ? `${stats.multiComponentComplaints.toLocaleString()} complaint(s) were filed against more than one component and appeared as multiple rows. Each is stored as ONE report so it is not counted as several independent customer reports.`
          : "No repeated complaint IDs were found, so every row became its own report.",
      sourceType: "real",
      sourceLabel: "NHTSA / Public",
      sourceNote:
        "Imported as public NHTSA complaint data — one owner, one vehicle per report. These are not internal OEM support tickets.",
      pending: inserted,
      suggestedBatch: Math.min(ANALYZE_BATCH, inserted),
      corpus: corpusStats(),
    });
  } catch (e) {
    res.status(400).json(importFailure(e, text));
  }
});

/* ---------------------------------------------------------------- import: analyze */

/**
 * §15 — triage a batch of pending reports one at a time so the client can show
 * "Analyzing 12 of 40…". Every report gets its own similarity retrieval (§18) and a
 * failure on one report never aborts the batch or discards the report.
 */
app.post("/api/import/analyze", async (req, res) => {
  const limit = clamp(Number(req.body?.limit) || ANALYZE_BATCH, 1, ANALYZE_MAX);
  const queue = pendingReports(limit);
  if (!queue.length) {
    return res.json({
      analyzed: 0, failed: 0, total: 0, results: [],
      message: "Every imported report has already been triaged.",
      corpus: corpusStats(),
    });
  }

  const results = [];
  let analyzed = 0;
  let failed = 0;

  for (const report of queue) {
    try {
      const { triage } = await analyzeStored(report);
      analyzed++;
      results.push({
        id: report.id, ok: true,
        severity: triage.severity, subsystem: triage.subsystem,
        issueType: triage.issue_type, source: triage.source,
      });
    } catch (e) {
      // The report stays in the corpus, flagged, with no invented values (§17/§26).
      markAnalysisFailed(report.id);
      failed++;
      results.push({ id: report.id, ok: false, error: String(e.message || e) });
    }
  }
  persist(true);
  invalidateThemeCache();
  res.json({
    analyzed, failed, total: queue.length, results,
    remaining: corpusStats().pending,
    corpus: corpusStats(),
    mode: isDemo() ? "demo" : "live",
    note: failed
      ? `${failed} report(s) could not be triaged. They are still in the corpus, flagged "Not yet triaged" rather than given guessed values.`
      : null,
  });
});

/** Progress polling for a batch already under way, plus what is left to do. */
app.get("/api/import/progress", (_req, res) => {
  const c = corpusStats();
  res.json({ ...c, remaining: c.pending, batchSize: ANALYZE_BATCH });
});

app.get("/api/import/datasets", (_req, res) => {
  res.json({ datasets: listDatasets(), corpus: corpusStats() });
});

/** Removing imported data can never touch seed reports — they have no dataset_id. */
app.delete("/api/import/datasets/:id", (req, res) => {
  const removed = deleteDataset(req.params.id);
  persist(true);
  invalidateThemeCache();
  res.json({ removed, corpus: corpusStats() });
});

app.delete("/api/reports/imported", (_req, res) => {
  const removed = deleteAllImported();
  persist(true);
  invalidateThemeCache();
  res.json({ removed, corpus: corpusStats(), note: "Seed and demo reports were left untouched." });
});

/* ---------------------------------------------------------------------- helpers */

/** Shared response shape for both /api/analyze and per-report analysis. */
function envelope(triage, sim) {
  return {
    demoMode: isDemo(),
    mode: triage.mode || (isDemo() ? "demo" : "live"),
    analysisSource: triage.source,
    analysisLabel: triage.severity_engine || (isDemo() ? "Fallback · Rule-based" : "Live LLM"),
    disclaimer: triage.notice || (triage.severity_engine === "Live LLM" ? "Live LLM — review before escalation." : "Live analysis unavailable, showing rule-based result"),
    notice: triage.notice || null,
    model: isDemo() ? null : modelName(),
    labels: SEVERITY_LABELS,
    triage,
    similar: sim?.matches || [],
    similarity: {
      engine: sim?.engine || "lexical",
      engineIsSemantic: false,
      degraded: false,
      baseline: sim?.baseline,
      comparedAgainst: sim?.comparedAgainst,
      note:
        sim?.engine === "llm"
          ? "Similar reports picked by the model from a shortlist of existing summaries (not embeddings)."
          : "Similar reports from lexical overlap (Demo Mode).",
    },
    noStrongDuplicates: sim?.noStrongMatches ?? !sim?.matches?.length,
  };
}

/** Analyzes a stored report and writes the result back. Throws on live failure. */
async function analyzeStored(report) {
  const text = buildAnalysisText(report);
  const corpus = listReports();
  const candidates = pickCandidateSummaries(text, corpus, { excludeId: report.id, limit: 15 });
  const raw = getRawData(report.id);
  const meta = report.metadata || raw?.metadata || {};
  const row0 = raw?.rows?.[0] || {};
  const triage = await analyzeReport(text, {
    apiKey: apiKey(),
    model: process.env.GROQ_MODEL || process.env.OPENAI_MODEL,
    candidates,
    metadata: {
      sourceType: report.sourceType,
      vehicle: report.vehicleModel,
      component: report.component,
      occurrences: report.occurrences,
      crash: meta.crash ?? row0.CRASH,
      fire: meta.fire ?? row0.FIRE,
      injured: meta.injured ?? row0.INJURED,
      deaths: meta.deaths ?? row0.DEATHS,
      raw_complaint: report.rawText,
      raw,
    },
  });
  saveAnalysis(report.id, triage, { status: "analyzed", source: triage.source });
  invalidateThemeCache();
  const similar = await resolveSimilar(text, triage, candidates, corpus, report.id);
  return { triage, similar };
}

async function resolveSimilar(text, triage, candidates, corpus, excludeId) {
  const llm = llmSimilarEnvelope(triage, candidates, corpus, excludeId);
  if (llm) return llm;
  return findSimilarReports(text, corpus, { limit: 3, excludeId });
}

function llmSimilarEnvelope(triage, candidates, corpus, excludeId) {
  const fromLlm = Array.isArray(triage.similar_reports) ? triage.similar_reports : null;
  if (triage.mode === "live" && fromLlm) {
    const byId = new Map(corpus.map((r) => [r.id, r]));
    const matches = fromLlm
      .filter((s) => s.id !== excludeId)
      .map((s) => {
        const r = byId.get(s.id);
        return {
          ...s,
          relation: s.relation || (s.similarity >= 90 ? "Possible duplicate — verify" : "Similar report"),
          shortDescription: s.shortDescription || r?.triageSummary || "",
          severity: r?.severity,
          sourceType: r?.sourceType,
          vehicleModel: r?.vehicleModel,
        };
      });
    return {
      matches,
      engine: "llm",
      degraded: false,
      comparedAgainst: candidates.length,
      noStrongMatches: matches.length === 0,
    };
  }
  return null; // filled async by caller for demo
}

/** §26 — a failed live call must never look like a lost report. */
function liveFailure(e) {
  if (e instanceof LiveAnalysisError) {
    return {
      error: "Live analysis failed — try again or use Demo Mode.",
      code: e.code,
      attempts: e.attempts,
      detail: String(e.message || ""),
      recoverable: true,
    };
  }
  return { error: "Live analysis failed — try again or use Demo Mode.", code: "UNEXPECTED", recoverable: true, detail: String(e.message || e) };
}

/** §26 — import errors name the column problem and offer manual selection. */
function importFailure(e, text) {
  if (e instanceof ImportError) {
    const body = { error: e.message, code: e.code };
    if (e.headers) {
      body.headers = e.headers;
      // A header name alone is often useless for choosing ("COLUMN_7", "FIELD_22"), so
      // each option carries the first real value found in that column.
      body.columnOptions = e.headers.map((h, i) => ({ index: i, name: h, sample: e.samples?.[i] || "" }));
      body.hint = "Pick the column that holds the complaint text and import again.";
    }
    if (e.code === "NO_DESCRIPTION" && !e.headers && text) {
      body.hint = "Pick the column that holds the complaint text and import again.";
    }
    return body;
  }
  return { error: `We couldn't read that file: ${String(e.message || e)}`, code: "PARSE_FAILED" };
}

/** §11 — row count, first 10 rows, and what each detected column means. */
function previewPayload(parsed, { filename } = {}) {
  const { headers, rows, mapping, delimiterName: delim, schema, headerless, descriptionGuessed } = parsed;
  const detected = Object.entries(FIELD_LABELS)
    .filter(([field]) => mapping[field] !== undefined)
    .map(([field, label]) => ({
      field,
      label,
      columnIndex: mapping[field],
      columnName: headers[mapping[field]],
      sample: firstNonEmpty(rows, mapping[field]),
    }));

  const mapped = new Set(Object.values(mapping));
  return {
    filename: filename || null,
    rowCount: rows.length,
    rowCountLabel: `${rows.length.toLocaleString()} rows detected`,
    delimiter: delim,
    schema,
    headerless,
    headerNote: headerless
      ? schema === "nhtsa-flat"
        ? "No header row found. The file matches the NHTSA flat-file layout, so standard NHTSA column names were applied by position."
        : "No header row found, so columns are numbered."
      : null,
    headers,
    columnOptions: headers.map((h, i) => ({ index: i, name: h, mapped: mapped.has(i) })),
    detected,
    descriptionColumn: mapping.description,
    descriptionColumnName: headers[mapping.description],
    descriptionGuessed,
    descriptionNote: descriptionGuessed
      ? "No CDESCR column was found, so the longest free-text column was used as the complaint description. Change it below if that is wrong."
      : null,
    sampleRows: rows.slice(0, PREVIEW_ROWS).map((r) => headers.map((_, i) => String(r[i] ?? ""))),
    previewCount: Math.min(PREVIEW_ROWS, rows.length),
    sourceType: "real",
    sourceLabel: "NHTSA / Public",
    sourceNote: "Will be imported as public complaint data, clearly separated from synthetic demo reports.",
  };
}

const FIELD_LABELS = {
  reportId: "Report ID",
  odino: "Complaint ID (ODINO)",
  manufacturer: "Manufacturer",
  make: "Make",
  model: "Vehicle",
  modelYear: "Model year",
  component: "Component",
  description: "Complaint description",
  occurrences: "Occurrence count",
  failDate: "Failure date",
  reportDate: "Report date",
  city: "City",
  state: "State",
  dealerName: "Dealer",
};

function firstNonEmpty(rows, idx) {
  for (const r of rows.slice(0, 40)) {
    const v = String(r[idx] ?? "").trim();
    if (v) return v.length > 120 ? `${v.slice(0, 119)}…` : v;
  }
  return "";
}

/** Accepts both a raw-text upload and a JSON body, so the client can use either. */
function uploadBody(req) {
  if (typeof req.body === "string") {
    return {
      text: req.body,
      descriptionColumn: req.query.descriptionColumn ?? null,
      filename: req.query.filename || null,
      limit: req.query.limit || null,
      local: req.query.local === "1" || req.query.local === "true",
    };
  }
  const b = req.body || {};
  return {
    text: String(b.text || ""),
    descriptionColumn: b.descriptionColumn ?? null,
    filename: b.filename || null,
    limit: b.limit ?? null,
    local: Boolean(b.local),
  };
}

const FLAT_FILE_CANDIDATES = ["FLAT_CMPL.txt", "nhtsa_sample.csv", "nhtsa_sample.txt"];

function flatFileStatus() {
  const dir = path.join(__dirname, "..", "data");
  const searched = FLAT_FILE_CANDIDATES.map((f) => path.join("data", f));
  for (const name of FLAT_FILE_CANDIDATES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      const { size } = fs.statSync(p);
      return {
        available: true, path: p, filename: name,
        sizeBytes: size, sizeLabel: formatBytes(size), searched,
      };
    }
  }
  return { available: false, path: null, filename: null, searched };
}

/** The browser-safe view: filename and size, never an absolute server path. */
function publicFlatFileStatus() {
  const { path: _abs, ...rest } = flatFileStatus();
  return rest;
}

async function localParsed(limit) {
  const status = flatFileStatus();
  if (!status.available) throw new ImportError("No local NHTSA file found in data/.", { code: "NOT_FOUND" });
  return readLocal(status, limit);
}

/**
 * Picks the right reader for a file already on disk.
 *
 * streamFlatFile reads line-by-line, which is the only way to touch a 1.6 GB file — but
 * it cannot reassemble a quoted CSV field that contains a newline. So a small CSV is
 * read whole by parseUpload (correct quoting), and anything large is streamed.
 */
const STREAM_ABOVE_BYTES = 40 * 1024 * 1024;

async function readLocal(status, limit) {
  const streamIt = status.sizeBytes > STREAM_ABOVE_BYTES || /\.(txt|tsv)$/i.test(status.filename);
  if (streamIt) return streamFlatFile(status.path, { limit });
  const text = fs.readFileSync(status.path, "utf8");
  return { ...parseUpload(text, { limit }), fileSize: status.sizeBytes };
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

function stripReports(t) {
  const { reports, ...rest } = t;
  return rest;
}

/* ------------------------------------------------------------------ static + boot */

const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) next();
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VehiclePulse API http://127.0.0.1:${PORT}  demoMode=${isDemo()}`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
