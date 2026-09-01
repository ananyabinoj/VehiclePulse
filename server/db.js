import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";
import { REPORTS } from "./seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "vehiclepulse.db");

let db;

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

export async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const file = fs.readFileSync(DB_PATH);
    db = new SQL.Database(file);
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

  const count = get("SELECT COUNT(*) AS c FROM reports");
  if (!count || count.c === 0) {
    const insert = db.prepare(`
      INSERT INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const r of REPORTS) {
      insert.bind([
        r.id,
        r.date,
        r.rawText,
        r.vehicleModel,
        r.softwareVersion,
        r.affectedVehicles,
        r.source,
        r.location,
        r.subsystem,
        r.severity,
        r.severityReason,
        r.recoveryPath,
        r.recoveryReason,
        r.triggerCondition,
        r.triggerReason,
        r.suggestedOwner,
        r.ownerReason,
        r.theme,
        r.triageSummary,
      ]);
      insert.step();
      insert.reset();
    }
    insert.free();
    persist();
  }
}

export function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

export function rowToReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    rawText: row.raw_text,
    vehicleModel: row.vehicle_model,
    softwareVersion: row.software_version,
    affectedVehicles: row.affected_vehicles,
    source: row.source,
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
    theme: row.theme,
    triageSummary: row.triage_summary,
  };
}

export function listReports() {
  return all("SELECT * FROM reports ORDER BY date DESC, id ASC").map(rowToReport);
}

export function getReport(id) {
  return rowToReport(get("SELECT * FROM reports WHERE id = ?", [id]));
}

export function searchReports({ q, theme, model }) {
  let sql = "SELECT * FROM reports WHERE 1=1";
  const params = [];
  if (q) {
    sql += " AND (id LIKE ? OR raw_text LIKE ? OR theme LIKE ? OR vehicle_model LIKE ? OR subsystem LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
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

export { all, get };
