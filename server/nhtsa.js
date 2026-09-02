/**
 * nhtsa.js — parse and normalize imported complaint data.
 *
 * Handles three shapes without asking the user to map columns by hand:
 *   1. CSV/TSV with recognizable NHTSA headers (CMPLID, ODINO, CDESCR, ...)
 *   2. CSV with arbitrary headers (Description, Complaint, Narrative, ...)
 *   3. The raw NHTSA FLAT_CMPL.txt flat file, which is tab-delimited with NO header row
 *      and must be read positionally.
 *
 * Nothing here calls the LLM. Rows are parsed and normalized locally, then stored, so
 * a 2.24M-row dataset never gets pushed through a model (§12).
 */
import fs from "fs";
import readline from "readline";

/** Positional schema of the NHTSA complaints flat file, in file order. */
export const NHTSA_FLAT_FIELDS = [
  "CMPLID", "ODINO", "MFR_NAME", "MAKETXT", "MODELTXT", "YEARTXT",
  "CRASH", "FAILDATE", "FIRE", "INJURED", "DEATHS", "COMPDESC",
  "CITY", "STATE", "VIN", "DATEA", "LDATE", "MILES", "OCCURENCES",
  "CDESCR", "CMPL_TYPE", "POLICE_RPT_YN", "PURCH_DT", "ORIG_OWNER_YN",
  "ANTI_BRAKES_YN", "CRUISE_CONT_YN", "NUM_CYLS", "DRIVE_TRAIN", "FUEL_SYS",
  "FUEL_TYPE", "TRANS_TYPE", "VEH_SPEED", "DOT", "TIRE_SIZE", "LOC_OF_TIRE",
  "TIRE_FAIL_TYPE", "ORIG_EQUIP_YN", "MANUF_DT", "SEAT_TYPE", "RESTRAINT_TYPE",
  "DEALER_NAME", "DEALER_TEL", "DEALER_CITY", "DEALER_STATE", "DEALER_ZIP",
  "PROD_TYPE", "REPAIRED_YN", "MEDICAL_ATTN", "VEHICLES_TOWED_YN",
];

/**
 * Logical fields the app needs, each with candidate header names ordered by
 * confidence. The first entry is the canonical NHTSA name.
 */
const FIELD_CANDIDATES = {
  description: ["cdescr", "complaint_description", "complaintdescription", "description", "complaint", "narrative", "summary", "details", "detail", "comments", "comment", "body", "text", "issue", "problem", "remarks"],
  reportId: ["cmplid", "complaint_id", "complaintid", "id", "record_id", "ticket", "ticket_id", "reference"],
  odino: ["odino", "odi_number", "odinumber", "nhtsa_id"],
  manufacturer: ["mfr_name", "manufacturer", "mfr", "oem", "manufacturer_name"],
  make: ["maketxt", "make", "brand", "vehicle_make"],
  model: ["modeltxt", "model", "vehicle_model", "modelname"],
  modelYear: ["yeartxt", "model_year", "year", "modelyear", "vehicle_year"],
  component: ["compdesc", "component", "component_description", "subsystem", "system", "part"],
  occurrences: ["occurences", "occurrences", "occurrence_count", "count", "num_occurrences"],
  failDate: ["faildate", "failure_date", "fail_date", "incident_date", "date_of_failure"],
  reportDate: ["ldate", "datea", "date_added", "date", "received_date", "created_at", "reported"],
  city: ["city", "consumer_city"],
  state: ["state", "consumer_state"],
  vin: ["vin", "vehicle_id", "vin_prefix"],
  dealerName: ["dealer_name", "dealername", "dealer", "servicing_dealer"],
  dealerCity: ["dealer_city", "dealercity"],
  dealerState: ["dealer_state", "dealerstate"],
  crash: ["crash", "was_crash", "accident"],
  fire: ["fire", "was_fire"],
  injured: ["injured", "injuries", "num_injured"],
  deaths: ["deaths", "fatalities", "num_deaths"],
  miles: ["miles", "mileage", "odometer"],
  towed: ["vehicles_towed_yn", "towed", "was_towed"],
};

const norm = (s) =>
  String(s || "").toLowerCase().replace(/^﻿/, "").replace(/[\s\-.]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "");

/* ------------------------------------------------------------- delimited parsing */

/** Picks the delimiter whose field count is both largest and most consistent. */
export function sniffDelimiter(sample) {
  const lines = String(sample).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!lines.length) return ",";
  const candidates = ["\t", ",", "|", ";"];
  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => splitRow(l, d).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * consistent;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Tab-delimited NHTSA flat files are NOT quoted — a `"` inside a narrative is a
 * literal character. Treating it as a quote char silently swallows newlines and
 * merges rows, so quote handling is only enabled for comma-family delimiters.
 */
const usesQuoting = (delim) => delim !== "\t";

/** Splits a single line, honouring double-quoted fields with escaped "" pairs. */
function splitRow(line, delim, quoted = usesQuoting(delim)) {
  if (!quoted) return line.split(delim).map((c) => c.trim());
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Full parse that tolerates newlines inside quoted fields — necessary because real
 * complaint narratives are often multi-line.
 */
export function parseDelimited(text, delim, limit = Infinity) {
  const quoted = usesQuoting(delim);
  // Unquoted (tab/flat-file) input is strictly one record per line.
  if (!quoted) {
    const out = [];
    for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
      if (out.length >= limit) break;
      if (!line.trim()) continue;
      out.push(splitRow(line, delim, false));
    }
    return out;
  }
  const rows = [];
  let cur = [];
  let field = "";
  let inQ = false;
  const src = String(text).replace(/^﻿/, "");
  const pushField = () => {
    cur.push(field.trim());
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (cur.length > 1 || cur[0] !== "") rows.push(cur);
    cur = [];
  };
  for (let i = 0; i < src.length; i++) {
    if (rows.length >= limit) break;
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      /* skip */
    } else field += ch;
  }
  if (field || cur.length) pushRow();
  return rows;
}

/* ------------------------------------------------------- header / shape detection */

/**
 * The flat file has no header. Detect it from shape: many columns, a numeric first
 * cell, and a plausible model year in the YEARTXT slot.
 */
export function looksLikeNhtsaFlat(firstRow) {
  if (!firstRow || firstRow.length < 20) return false;
  const numericId = /^\d+$/.test(firstRow[0] || "");
  const numericOdino = /^\d+$/.test(firstRow[1] || "");
  const yearish = /^(19|20)\d{2}$|^9999$/.test(firstRow[5] || "");
  const longNarrative = (firstRow[19] || "").length > 25;
  return numericId && numericOdino && (yearish || longNarrative);
}

function headerLooksLikeData(row) {
  // A header row shouldn't be mostly numbers or contain a long sentence.
  const numeric = row.filter((c) => /^\d+$/.test(c)).length;
  const longest = Math.max(0, ...row.map((c) => c.length));
  return numeric > row.length / 2 || longest > 80;
}

/** Maps logical field -> column index using header names. */
export function detectMapping(headers) {
  const normed = headers.map(norm);
  const mapping = {};
  const used = new Set();
  for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
    for (const cand of candidates) {
      const idx = normed.indexOf(cand);
      if (idx !== -1 && !used.has(idx)) {
        mapping[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Last resort when no header name looks like a description: pick the column with the
 * longest average content. Returns null if nothing looks like prose, which lets the
 * caller show the §26 error and offer manual selection.
 */
function guessDescriptionColumn(rows, headers) {
  const width = headers.length;
  const sums = new Array(width).fill(0);
  const counts = new Array(width).fill(0);
  for (const r of rows.slice(0, 200)) {
    for (let i = 0; i < width; i++) {
      const v = r[i] || "";
      sums[i] += v.length;
      if (v) counts[i]++;
    }
  }
  let bestIdx = -1;
  let bestAvg = 0;
  for (let i = 0; i < width; i++) {
    const avg = counts[i] ? sums[i] / counts[i] : 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIdx = i;
    }
  }
  return bestAvg >= 40 ? { index: bestIdx, avgLength: Math.round(bestAvg) } : null;
}

export class ImportError extends Error {
  constructor(message, { code = "PARSE_FAILED", headers = null, samples = null } = {}) {
    super(message);
    this.code = code;
    this.headers = headers;
    // First non-empty value per column, so a manual column picker can show the user
    // what is actually in each one rather than just a header name (§26).
    this.samples = samples;
  }
}

/** First non-empty value in each column, truncated for display. */
export function columnSamples(rows, headers) {
  return headers.map((_, i) => {
    for (const r of rows.slice(0, 40)) {
      const v = String(r[i] ?? "").trim();
      if (v) return v.length > 80 ? `${v.slice(0, 79)}…` : v;
    }
    return "";
  });
}

/**
 * Parses an uploaded CSV/TXT payload into { headers, rows, mapping, ... }.
 * `descriptionColumn` lets the user override auto-detection (§26).
 */
export function parseUpload(text, { descriptionColumn = null, limit = Infinity } = {}) {
  const raw = String(text || "");
  if (!raw.trim()) throw new ImportError("The file is empty.", { code: "EMPTY" });

  const delimiter = sniffDelimiter(raw.slice(0, 200_000));
  const allRows = parseDelimited(raw, delimiter, limit === Infinity ? Infinity : limit + 1);
  if (!allRows.length) throw new ImportError("No rows could be read from the file.", { code: "EMPTY" });

  let headers;
  let rows;
  let headerless = false;
  let schema = "generic";

  if (looksLikeNhtsaFlat(allRows[0])) {
    // Raw NHTSA flat file: positional, no header row.
    headerless = true;
    schema = "nhtsa-flat";
    headers = NHTSA_FLAT_FIELDS.slice(0, Math.max(allRows[0].length, NHTSA_FLAT_FIELDS.length));
    while (headers.length < allRows[0].length) headers.push(`FIELD_${headers.length + 1}`);
    rows = allRows;
  } else if (headerLooksLikeData(allRows[0])) {
    headerless = true;
    headers = allRows[0].map((_, i) => `COLUMN_${i + 1}`);
    rows = allRows;
  } else {
    headers = allRows[0];
    rows = allRows.slice(1);
  }

  if (!rows.length) throw new ImportError("The file has a header but no data rows.", { code: "NO_ROWS", headers });

  const mapping = headerless && schema === "nhtsa-flat" ? detectMapping(NHTSA_FLAT_FIELDS) : detectMapping(headers);
  if (headers.some((h) => /^cdescr$/i.test(String(h).trim())) || schema === "nhtsa-flat") schema = "nhtsa";

  let descriptionGuessed = false;
  if (descriptionColumn !== null && descriptionColumn !== undefined && descriptionColumn !== "") {
    const idx = Number(descriptionColumn);
    if (!Number.isInteger(idx) || idx < 0 || idx >= headers.length) {
      throw new ImportError("The selected description column is out of range.", { code: "BAD_COLUMN", headers, samples: columnSamples(rows, headers) });
    }
    mapping.description = idx;
  } else if (mapping.description === undefined) {
    const guess = guessDescriptionColumn(rows, headers);
    if (!guess) {
      throw new ImportError(
        "We couldn't identify a complaint-description column. Expected something like CDESCR or Description.",
        { code: "NO_DESCRIPTION", headers, samples: columnSamples(rows, headers) }
      );
    }
    mapping.description = guess.index;
    descriptionGuessed = true;
  }

  return { delimiter, delimiterName: delimiterName(delimiter), headers, rows, mapping, headerless, schema, descriptionGuessed };
}

function delimiterName(d) {
  return { "\t": "tab", ",": "comma", "|": "pipe", ";": "semicolon" }[d] || d;
}

/* ------------------------------------------------------------------ normalization */

/**
 * Title-cases vehicle text while leaving genuine identifiers alone: tokens containing
 * a digit (EV6, XC60, F-150) and short vowel-less acronyms (BMW, GMC, VW) stay as-is,
 * so "KIA EV6" doesn't become the wrong-looking "Kia Ev6".
 */
const titleCase = (s) =>
  String(s || "")
    .trim()
    .split(/\s+/)
    .map(titleToken)
    .join(" ")
    .trim();

function titleToken(tok) {
  if (!tok) return tok;
  if (/\d/.test(tok)) return tok; // EV6, F-150, XC60 — identifiers, leave alone
  // Recurse across hyphens so MERCEDES-BENZ -> Mercedes-Benz and CR-V -> CR-V
  if (tok.includes("-")) return tok.split("-").map(titleToken).join("-");
  if (!/[AEIOU]/i.test(tok) && tok.length <= 3) return tok.toUpperCase(); // BMW, GMC, VW
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

function ymd(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function intOrNull(v) {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : Number(v) === 0 ? 0 : null;
}

const yes = (v) => /^(y|yes|true|1)$/i.test(String(v || "").trim());

/**
 * Turns parsed rows into normalized report objects (§13).
 *
 * Rows sharing an ODINO are ONE customer complaint filed against several components,
 * so they collapse into one report whose component list preserves every relationship.
 * That keeps the Themes vehicle maths honest (§14).
 */
export function normalizeReports(parsed, { datasetId, idFactory, sourceType = "real", sourceLabel = "NHTSA / Public" } = {}) {
  const { rows, mapping, headers } = parsed;
  const cell = (row, field) => {
    const i = mapping[field];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };

  const groups = new Map();
  let skippedEmpty = 0;
  let rowsSeen = 0;

  for (const row of rows) {
    rowsSeen++;
    const description = cell(row, "description");
    if (description.length < 15) {
      skippedEmpty++;
      continue;
    }
    // Group by ODINO when present; otherwise by report id; otherwise treat each row alone.
    const key = cell(row, "odino") || cell(row, "reportId") || `row-${rowsSeen}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const reports = [];
  const importedAt = new Date().toISOString();

  for (const [key, groupRows] of groups) {
    const first = groupRows[0];
    const components = [...new Set(groupRows.map((r) => cell(r, "component")).filter(Boolean))];
    const description = groupRows.map((r) => cell(r, "description")).sort((a, b) => b.length - a.length)[0];

    const make = titleCase(cell(first, "make"));
    const model = titleCase(cell(first, "model"));
    const modelYear = intOrNull(cell(first, "modelYear"));
    const vehicleModel = [make, model].filter(Boolean).join(" ") || null;

    const occurrences = Math.max(1, ...groupRows.map((r) => intOrNull(cell(r, "occurrences")) || 1));

    const rawRows = groupRows.map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = r[i];
        if (v !== undefined && String(v).trim() !== "") obj[h] = String(v).trim();
      });
      return obj;
    });

    reports.push({
      id: idFactory(),
      date: ymd(cell(first, "reportDate")) || ymd(cell(first, "failDate")) || importedAt.slice(0, 10),
      rawText: description,
      vehicleModel,
      model: model || null,
      softwareVersion: null,
      // A consumer complaint is one owner's vehicle. That is a known count of 1 —
      // not an estimate, and not a stand-in for fleet-wide exposure (§21).
      affectedVehicles: 1,
      affectedVehicleBasis:
        "One public complaint filed by one vehicle owner. Not a fleet-wide count.",
      source: sourceLabel,
      sourceType,
      location: [titleCase(cell(first, "city")), cell(first, "state").toUpperCase()].filter(Boolean).join(", ") || null,
      manufacturer: cell(first, "manufacturer") || null,
      make: make || null,
      modelYear,
      component: components.join("; ") || null,
      components,
      occurrences,
      odino: cell(first, "odino") || null,
      externalId: cell(first, "reportId") || null,
      rawData: {
        rowCount: groupRows.length,
        groupedBy: cell(first, "odino") ? "ODINO" : "row",
        groupKey: key,
        rows: rawRows,
      },
      // Safety signals that legitimately inform severity, carried through as metadata.
      metadata: {
        crash: yes(cell(first, "crash")),
        fire: yes(cell(first, "fire")),
        injured: intOrNull(cell(first, "injured")) || 0,
        deaths: intOrNull(cell(first, "deaths")) || 0,
        towed: yes(cell(first, "towed")),
        miles: intOrNull(cell(first, "miles")),
        failDate: ymd(cell(first, "failDate")),
        dealer: [cell(first, "dealerName"), titleCase(cell(first, "dealerCity")), cell(first, "dealerState").toUpperCase()]
          .filter(Boolean)
          .join(", ") || null,
        componentCount: components.length,
      },
      analysisStatus: "pending",
      analysisSource: null,
      datasetId,
      importedAt,
      // Left null on purpose: severity and friends must come from analysis, not import.
      subsystem: null, severity: null, severityReason: null,
      recoveryPath: null, recoveryReason: null,
      triggerCondition: null, triggerReason: null,
      suggestedOwner: null, ownerReason: null,
      issueType: null, theme: null, triageSummary: null,
    });
  }

  return {
    reports,
    stats: {
      rowsSeen,
      rowsSkippedNoDescription: skippedEmpty,
      distinctComplaints: reports.length,
      multiComponentComplaints: reports.filter((r) => r.components.length > 1).length,
    },
  };
}

/**
 * "2013 Ford F-150" — never "2013 Ford Ford F-150".
 *
 * `vehicleModel` is stored as "MAKE MODEL" for imported complaints, and after a database
 * round-trip `model` comes back as an alias of it, so joining make + vehicleModel + model
 * blindly repeats the make. Parts are folded by containment: a longer part that already
 * contains a shorter one replaces it, and an exact repeat is dropped.
 */
export function vehicleLabel(report = {}) {
  const parts = [];
  for (const raw of [report.make, report.vehicleModel, report.model]) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (parts.some((q) => q.toLowerCase().includes(low))) continue;
    const i = parts.findIndex((q) => low.includes(q.toLowerCase()));
    if (i >= 0) parts[i] = s;
    else parts.push(s);
  }
  return [report.modelYear ? String(report.modelYear) : "", ...parts].filter(Boolean).join(" ");
}

/**
 * Builds the text handed to the LLM and the embedding model: metadata first, then the
 * narrative. §12 — the description alone loses the vehicle context that changes triage.
 */
export function buildAnalysisText(report) {
  const meta = [];
  if (report.manufacturer) meta.push(`Manufacturer: ${report.manufacturer}`);
  const veh = vehicleLabel(report);
  if (veh) meta.push(`Vehicle: ${veh}`);
  if (report.softwareVersion) meta.push(`Software version: ${report.softwareVersion}`);
  if (report.component) meta.push(`Component(s) cited: ${report.component}`);
  if (report.location) meta.push(`Location: ${report.location}`);
  if (report.occurrences && report.occurrences > 1) meta.push(`Reported occurrences: ${report.occurrences}`);

  const m = report.metadata || {};
  const flags = [];
  if (m.crash) flags.push("crash reported");
  if (m.fire) flags.push("fire reported");
  if (m.injured) flags.push(`${m.injured} injured`);
  if (m.deaths) flags.push(`${m.deaths} deaths`);
  if (m.towed) flags.push("vehicle towed");
  if (flags.length) meta.push(`Reported outcomes: ${flags.join(", ")}`);
  if (m.miles) meta.push(`Mileage at failure: ${m.miles}`);
  if (m.dealer) meta.push(`Servicing dealer: ${m.dealer}`);
  if (report.sourceType === "real") {
    meta.push("Data source: public NHTSA consumer complaint (one owner, one vehicle) — not an internal OEM support ticket.");
  }

  return `${meta.join("\n")}\n\nComplaint description:\n${report.rawText || ""}`.trim();
}

/* ------------------------------------------------------- streaming the flat file */

/**
 * Reads the head of a very large flat file without loading it into memory.
 * Returns the same shape as parseUpload so downstream code is identical.
 */
export async function streamFlatFile(filePath, { limit = 2000 } = {}) {
  if (!fs.existsSync(filePath)) throw new ImportError(`File not found: ${filePath}`, { code: "NOT_FOUND" });
  const { size } = fs.statSync(filePath);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const rows = [];
  let delimiter = "\t";
  let sniffed = false;
  let scanned = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!sniffed) {
      delimiter = sniffDelimiter(line);
      sniffed = true;
    }
    const cols = splitRow(line, delimiter);
    scanned++;
    if (cols.length >= 20) rows.push(cols);
    if (rows.length >= limit) break;
  }
  rl.close();

  if (!rows.length) throw new ImportError("No usable rows found in the file.", { code: "EMPTY" });

  const headerless = looksLikeNhtsaFlat(rows[0]);
  const headers = headerless
    ? NHTSA_FLAT_FIELDS.slice(0, Math.max(rows[0].length, NHTSA_FLAT_FIELDS.length))
    : rows.shift();
  while (headers.length < (rows[0]?.length || 0)) headers.push(`FIELD_${headers.length + 1}`);

  const mapping = detectMapping(headers);
  if (mapping.description === undefined) {
    throw new ImportError(
      "We couldn't identify a complaint-description column. Expected something like CDESCR or Description.",
      { code: "NO_DESCRIPTION", headers, samples: columnSamples(rows, headers) }
    );
  }

  return {
    delimiter,
    delimiterName: delimiterName(delimiter),
    headers,
    rows,
    mapping,
    headerless,
    schema: headerless ? "nhtsa-flat" : "nhtsa",
    descriptionGuessed: false,
    truncated: rows.length >= limit,
    fileSize: size,
    scanned,
  };
}
