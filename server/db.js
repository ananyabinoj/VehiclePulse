import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";
import { REPORTS } from "./seed.js";
import { normalizeRecovery } from "./rubric.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "vehiclepulse.db");

let db;
let dirty = false;

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

/**
 * Columns added after the original MVP shipped. Applied with ALTER TABLE so an
 * existing data/vehiclepulse.db keeps its 40 seed reports instead of being rebuilt.
 */
const ADDED_COLUMNS = [
  ["source_type", "TEXT"], // real | synthetic | demo  (§16)
  ["issue_type", "TEXT"], // Bug | Enhancement          (§22)
  ["manufacturer", "TEXT"],
  ["make", "TEXT"],
  ["model_year", "INTEGER"],
  ["component", "TEXT"],
  ["occurrences", "INTEGER"],
  ["odino", "TEXT"], // NHTSA complaint identifier      (§14)
  ["raw_data", "TEXT"], // original row as JSON          (§13)
  ["analysis_status", "TEXT"], // analyzed | pending | failed
  ["analysis_source", "TEXT"], // llm | seed | demo-example | lexical-baseline
  ["affected_vehicles_known", "INTEGER"], // 0 distinguishes "unknown" from the number 0
  ["affected_vehicle_basis", "TEXT"],
  ["dataset_id", "TEXT"],
  ["imported_at", "TEXT"],
];

function existingColumns(table) {
  return all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

function migrateReports() {
  const cols = existingColumns("reports");
  for (const [name, type] of ADDED_COLUMNS) {
    if (!cols.includes(name)) run(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
  }
}

export async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      date TEXT,
      raw_text TEXT,
      vehicle_model TEXT,
      software_version TEXT,
      affected_vehicles INTEGER,
      source TEXT,
      location TEXT,
      subsystem TEXT,
      severity TEXT,
      severity_reason TEXT,
      recovery_path TEXT,
      recovery_reason TEXT,
      trigger_condition TEXT,
      trigger_reason TEXT,
      suggested_owner TEXT,
      owner_reason TEXT,
      theme TEXT,
      triage_summary TEXT
    )
  `);
  migrateReports();

  // Embedding cache. Keyed by content hash + engine so switching engines never
  // mixes vector spaces, and re-importing the same text costs nothing.
  run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      hash TEXT NOT NULL,
      engine TEXT NOT NULL,
      dim INTEGER,
      vec TEXT,
      PRIMARY KEY (hash, engine)
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      filename TEXT,
      source_type TEXT,
      row_count INTEGER,
      report_count INTEGER,
      mapping TEXT,
      created_at TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS theme_cache (
      fingerprint TEXT PRIMARY KEY,
      payload TEXT,
      created_at TEXT
    )
  `);

  const count = get("SELECT COUNT(*) AS c FROM reports");
  if (!count || count.c === 0) seedInitialReports();

  backfillSeedMetadata();
  persist();
}

function seedInitialReports() {
  const insert = db.prepare(`
    INSERT INTO reports (
      id, date, raw_text, vehicle_model, software_version, affected_vehicles, source, location,
      subsystem, severity, severity_reason, recovery_path, recovery_reason, trigger_condition,
      trigger_reason, suggested_owner, owner_reason, theme, triage_summary
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const r of REPORTS) {
    insert.bind([
      r.id, r.date, r.rawText, r.vehicleModel, r.softwareVersion, r.affectedVehicles,
      r.source, r.location, r.subsystem, r.severity, r.severityReason,
      normalizeRecovery(r.recoveryPath), r.recoveryReason, r.triggerCondition,
      r.triggerReason, r.suggestedOwner, r.ownerReason, r.theme, r.triageSummary,
    ]);
    insert.step();
    insert.reset();
  }
  insert.free();
  dirty = true;
}

/**
 * The original 40 reports predate source_type / issue_type / analysis_status, and the
 * seed used the legacy "Technician / Service Visit" label. Fill those in once so the
 * theme maths and the honest "unknown vs known" distinction work on old databases too.
 */
function backfillSeedMetadata() {
  const pending = get(
    "SELECT COUNT(*) AS c FROM reports WHERE source_type IS NULL OR analysis_status IS NULL"
  );
  if (pending && pending.c > 0) {
    run(`
      UPDATE reports SET
        source_type = COALESCE(source_type, 'synthetic'),
        analysis_status = COALESCE(analysis_status, 'analyzed'),
        analysis_source = COALESCE(analysis_source, 'seed'),
        affected_vehicles_known = COALESCE(
          affected_vehicles_known,
          CASE WHEN affected_vehicles IS NULL THEN 0 ELSE 1 END
        ),
        issue_type = COALESCE(
          issue_type,
          CASE WHEN theme LIKE 'Enhancement%' THEN 'Enhancement' ELSE 'Bug' END
        )
      WHERE source_type IS NULL OR analysis_status IS NULL
    `);
    dirty = true;
  }

  // Canonicalize legacy recovery labels to the three values in the rubric.
  const legacy = get(
    "SELECT COUNT(*) AS c FROM reports WHERE recovery_path NOT IN ('OTA / Remote Recovery','Service Visit','Unknown') OR recovery_path IS NULL"
  );
  if (legacy && legacy.c > 0) {
    for (const row of all("SELECT id, recovery_path FROM reports")) {
      const norm = normalizeRecovery(row.recovery_path);
      if (norm !== row.recovery_path) {
        run("UPDATE reports SET recovery_path = ? WHERE id = ?", [norm, row.id]);
        dirty = true;
      }
    }
  }
}

export function persist(force = false) {
  if (!db) return;
  if (!dirty && !force) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  dirty = false;
}

export function rowToReport(row) {
  if (!row) return null;
  const known = row.affected_vehicles_known;
  return {
    id: row.id,
    date: row.date,
    rawText: row.raw_text,
    vehicleModel: row.vehicle_model,
    softwareVersion: row.software_version,
    // null means "we do not know", which is different from zero (§17).
    affectedVehicles: known === 0 || known === null || known === undefined ? null : row.affected_vehicles,
    affectedVehiclesKnown: known === 1,
    affectedVehicleBasis: row.affected_vehicle_basis || "",
    source: row.source,
    sourceType: row.source_type || "synthetic",
    location: row.location,
    subsystem: row.subsystem,
    severity: row.severity,
    severityReason: row.severity_reason,
    recoveryPath: row.recovery_path,
    recoveryReason: row.recovery_reason,
    triggerCondition: row.trigger_condition,
    triggerReason: row.trigger_reason,
    suggestedOwner: row.suggested_owner,
    ownerReason: row.owner_reason,
    issueType: row.issue_type || null,
    theme: row.theme || null,
    triageSummary: row.triage_summary,
    manufacturer: row.manufacturer || null,
    make: row.make || null,
    model: row.vehicle_model || null,
    modelYear: row.model_year || null,
    component: row.component || null,
    occurrences: row.occurrences ?? null,
    odino: row.odino || null,
    analysisStatus: row.analysis_status || "analyzed",
    analysisSource: row.analysis_source || "seed",
    datasetId: row.dataset_id || null,
    importedAt: row.imported_at || null,
    hasRawData: Boolean(row.raw_data),
  };
}

export function listReports({ analyzedOnly = false } = {}) {
  const where = analyzedOnly ? "WHERE analysis_status = 'analyzed'" : "";
  return all(`SELECT * FROM reports ${where} ORDER BY date DESC, id ASC`).map(rowToReport);
}

export function getReport(id) {
  return rowToReport(get("SELECT * FROM reports WHERE id = ?", [id]));
}

/** Returns the untouched original row (§13 — "View raw data"). */
export function getRawData(id) {
  const row = get("SELECT raw_data FROM reports WHERE id = ?", [id]);
  if (!row || !row.raw_data) return null;
  try {
    return JSON.parse(row.raw_data);
  } catch {
    return null;
  }
}

export function searchReports({ q, theme, model }) {
  let sql = "SELECT * FROM reports WHERE 1=1";
  const params = [];
  if (q) {
    sql +=
      " AND (id LIKE ? OR raw_text LIKE ? OR theme LIKE ? OR vehicle_model LIKE ? OR subsystem LIKE ? OR component LIKE ? OR make LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (theme) {
    sql += " AND theme = ?";
    params.push(theme);
  }
  if (model) {
    sql += " AND vehicle_model = ?";
    params.push(model);
  }
  sql += " ORDER BY date DESC";
  return all(sql, params).map(rowToReport);
}

export function countReports() {
  const r = get("SELECT COUNT(*) AS c FROM reports");
  return r ? r.c : 0;
}

export function corpusStats() {
  const row = get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN source_type = 'real' THEN 1 ELSE 0 END) AS real_count,
      SUM(CASE WHEN source_type = 'synthetic' THEN 1 ELSE 0 END) AS synthetic_count,
      SUM(CASE WHEN analysis_status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed,
      SUM(CASE WHEN analysis_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM reports
  `);
  return {
    total: row?.total || 0,
    real: row?.real_count || 0,
    synthetic: row?.synthetic_count || 0,
    analyzed: row?.analyzed || 0,
    pending: row?.pending || 0,
    failed: row?.failed || 0,
  };
}

/** Reports imported but not yet triaged, oldest first — the batch-analysis queue. */
export function pendingReports(limit = 40) {
  return all(
    "SELECT * FROM reports WHERE analysis_status = 'pending' ORDER BY imported_at ASC, id ASC LIMIT ?",
    [limit]
  ).map(rowToReport);
}

const INSERT_SQL = `
  INSERT OR REPLACE INTO reports (
    id, date, raw_text, vehicle_model, software_version, affected_vehicles, source, location,
    subsystem, severity, severity_reason, recovery_path, recovery_reason, trigger_condition,
    trigger_reason, suggested_owner, owner_reason, theme, triage_summary,
    source_type, issue_type, manufacturer, make, model_year, component, occurrences, odino,
    raw_data, analysis_status, analysis_source, affected_vehicles_known, affected_vehicle_basis,
    dataset_id, imported_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

export function insertReports(reports) {
  if (!reports.length) return 0;
  run("BEGIN TRANSACTION");
  const stmt = db.prepare(INSERT_SQL);
  let n = 0;
  try {
    for (const r of reports) {
      stmt.bind([
        r.id, r.date || null, r.rawText || "", r.vehicleModel || null, r.softwareVersion || null,
        r.affectedVehicles ?? null, r.source || null, r.location || null,
        r.subsystem || null, r.severity || null, r.severityReason || null,
        r.recoveryPath || null, r.recoveryReason || null, r.triggerCondition || null,
        r.triggerReason || null, r.suggestedOwner || null, r.ownerReason || null,
        r.theme || null, r.triageSummary || null,
        r.sourceType || "real", r.issueType || null, r.manufacturer || null, r.make || null,
        r.modelYear ?? null, r.component || null, r.occurrences ?? null, r.odino || null,
        r.rawData ? JSON.stringify(r.rawData) : null,
        r.analysisStatus || "pending", r.analysisSource || null,
        r.affectedVehicles === null || r.affectedVehicles === undefined ? 0 : 1,
        r.affectedVehicleBasis || null,
        r.datasetId || null, r.importedAt || new Date().toISOString(),
      ]);
      stmt.step();
      stmt.reset();
      n++;
    }
    run("COMMIT");
  } catch (e) {
    run("ROLLBACK");
    stmt.free();
    throw e;
  }
  stmt.free();
  dirty = true;
  clearThemeCache();
  return n;
}

/** Writes a triage result back onto a stored report. */
export function saveAnalysis(id, triage, { status = "analyzed", source = "llm" } = {}) {
  run(
    `UPDATE reports SET
       subsystem = ?, severity = ?, severity_reason = ?, recovery_path = ?, recovery_reason = ?,
       trigger_condition = ?, trigger_reason = ?, suggested_owner = ?, owner_reason = ?,
       triage_summary = ?, issue_type = ?, affected_vehicles = ?, affected_vehicles_known = ?,
       affected_vehicle_basis = ?, analysis_status = ?, analysis_source = ?
     WHERE id = ?`,
    [
      triage.subsystem, triage.severity, triage.severity_reason,
      triage.recovery_path, triage.recovery_reason,
      triage.trigger_condition, triage.trigger_reason,
      triage.suggested_owner, triage.owner_reason,
      triage.summary, triage.issue_type,
      triage.affected_vehicle_count ?? null,
      triage.affected_vehicle_count === null || triage.affected_vehicle_count === undefined ? 0 : 1,
      triage.affected_vehicle_basis || null,
      status, source, id,
    ]
  );
  dirty = true;
  clearThemeCache();
}

export function markAnalysisFailed(id) {
  run("UPDATE reports SET analysis_status = 'failed' WHERE id = ?", [id]);
  dirty = true;
}

export function nextReportId(prefix = "R") {
  const rows = all("SELECT id FROM reports WHERE id LIKE ?", [`${prefix}-%`]);
  let max = 0;
  for (const r of rows) {
    const m = String(r.id).match(/-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return (n = 1) => {
    max += n;
    return `${prefix}-${String(max).padStart(3, "0")}`;
  };
}

export function reportIdExists(id) {
  return Boolean(get("SELECT 1 AS x FROM reports WHERE id = ?", [id]));
}

/* ---------------------------------------------------------------- embeddings */

export function hashText(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

export function getEmbeddings(hashes, engine) {
  if (!hashes.length) return new Map();
  const out = new Map();
  const CHUNK = 400;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const slice = hashes.slice(i, i + CHUNK);
    const marks = slice.map(() => "?").join(",");
    for (const row of all(
      `SELECT hash, vec FROM embeddings WHERE engine = ? AND hash IN (${marks})`,
      [engine, ...slice]
    )) {
      try {
        out.set(row.hash, Float64Array.from(JSON.parse(row.vec)));
      } catch {
        /* corrupt cache entry — recompute */
      }
    }
  }
  return out;
}

export function putEmbeddings(entries, engine) {
  if (!entries.length) return;
  run("BEGIN TRANSACTION");
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO embeddings (hash, engine, dim, vec) VALUES (?,?,?,?)"
  );
  try {
    for (const { hash, vec } of entries) {
      stmt.bind([hash, engine, vec.length, JSON.stringify(Array.from(vec, (v) => Math.round(v * 1e5) / 1e5))]);
      stmt.step();
      stmt.reset();
    }
    run("COMMIT");
  } catch (e) {
    run("ROLLBACK");
    stmt.free();
    throw e;
  }
  stmt.free();
  dirty = true;
}

/* ------------------------------------------------------------------ datasets */

export function insertDataset(d) {
  run(
    "INSERT OR REPLACE INTO datasets (id, filename, source_type, row_count, report_count, mapping, created_at) VALUES (?,?,?,?,?,?,?)",
    [d.id, d.filename, d.sourceType, d.rowCount, d.reportCount, JSON.stringify(d.mapping || {}), new Date().toISOString()]
  );
  dirty = true;
}

export function listDatasets() {
  return all("SELECT * FROM datasets ORDER BY created_at DESC").map((r) => ({
    id: r.id,
    filename: r.filename,
    sourceType: r.source_type,
    rowCount: r.row_count,
    reportCount: r.report_count,
    createdAt: r.created_at,
  }));
}

/** Removes an imported dataset. Seed data has no dataset_id so it can never be hit. */
export function deleteDataset(id) {
  const before = countReports();
  run("DELETE FROM reports WHERE dataset_id = ?", [id]);
  run("DELETE FROM datasets WHERE id = ?", [id]);
  dirty = true;
  clearThemeCache();
  return before - countReports();
}

export function deleteAllImported() {
  const before = countReports();
  run("DELETE FROM reports WHERE dataset_id IS NOT NULL");
  run("DELETE FROM datasets");
  dirty = true;
  clearThemeCache();
  return before - countReports();
}

export function corpusFingerprint(reports) {
  const key = reports.map((r) => `${r.id}:${r.analysisStatus}:${r.severity || ""}:${r.theme || ""}`).join("|");
  return crypto.createHash("sha1").update(key).digest("hex");
}

export function getThemeCache(fp) {
  const row = get("SELECT payload FROM theme_cache WHERE fingerprint = ?", [fp]);
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function setThemeCache(fp, payload) {
  run("DELETE FROM theme_cache");
  run("INSERT INTO theme_cache (fingerprint, payload, created_at) VALUES (?,?,?)", [
    fp,
    JSON.stringify(payload),
    new Date().toISOString(),
  ]);
  dirty = true;
}

export function clearThemeCache() {
  try {
    run("DELETE FROM theme_cache");
    dirty = true;
  } catch {
    /* table may not exist yet during first migrate */
  }
}

export { all, get };
