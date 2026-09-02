/**
 * rubric.js — the single source of truth for VehiclePulse's controlled vocabularies.
 *
 * analyze.js, themes.js and the import pipeline all normalize through here, so an
 * LLM that returns "service visit" or "Technician / Service Visit" still lands on the
 * one canonical label the UI and the theme maths expect.
 */

export const SEVERITIES = ["P0", "P1", "P2", "P3"];

export const SEVERITY_WEIGHTS = { P0: 10, P1: 5, P2: 2, P3: 1 };

export const SEVERITY_LABELS = {
  P0: "P0 — Critical",
  P1: "P1 — High",
  P2: "P2 — Medium",
  P3: "P3 — Low",
};

/** §8 of the product rubric: exactly three recovery paths. */
export const RECOVERY_PATHS = ["OTA / Remote Recovery", "Service Visit", "Unknown"];

/** §10: the owner categories triage is allowed to assign. */
export const OWNERS = [
  "OTA Platform",
  "Vehicle Software",
  "Body Electronics",
  "Infotainment",
  "Connectivity",
  "Telematics",
  "Cloud Platform",
  "Mobile App",
  "Charging",
  "Diagnostics",
  "Field Engineering",
  "Product Management",
];

export const ISSUE_TYPES = ["Bug", "Enhancement"];

export const UNCLEAR_TRIGGER = "Trigger unclear";
export const OWNER_NEEDS_REVIEW = "Needs review";

export function normalizeSeverity(v) {
  const s = String(v || "").toUpperCase().match(/P[0-3]/);
  return s ? s[0] : null;
}

export function severityWeight(sev) {
  return SEVERITY_WEIGHTS[normalizeSeverity(sev)] ?? 1;
}

/** Ranks severities so "most severe present" is easy to compute. */
export function severityRank(sev) {
  const i = SEVERITIES.indexOf(normalizeSeverity(sev));
  return i === -1 ? SEVERITIES.length : i;
}

export function normalizeRecovery(v) {
  const s = String(v || "").toLowerCase().trim();
  if (!s) return "Unknown";
  // Legacy seed data used "Technician / Service Visit".
  if (/(technician|service|dealer|depot|workshop|reflash|replace)/.test(s) && !/remote|ota/.test(s)) {
    return "Service Visit";
  }
  if (/(ota|remote|backend|over.the.air|software update|config)/.test(s)) return "OTA / Remote Recovery";
  if (/(service|visit|physical)/.test(s)) return "Service Visit";
  return "Unknown";
}

export function normalizeOwner(v) {
  const raw = String(v || "").trim();
  if (!raw) return OWNER_NEEDS_REVIEW;
  const exact = OWNERS.find((o) => o.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const loose = OWNERS.find(
    (o) => raw.toLowerCase().includes(o.toLowerCase()) || o.toLowerCase().includes(raw.toLowerCase())
  );
  return loose || OWNER_NEEDS_REVIEW;
}

export function normalizeIssueType(v) {
  const s = String(v || "").toLowerCase();
  if (/enhanc|feature|request|improve|would like|nice to have/.test(s)) return "Enhancement";
  if (/bug|defect|fault|failure/.test(s)) return "Bug";
  return "Bug";
}

export function normalizeTrigger(v) {
  const s = String(v || "").trim();
  if (!s) return UNCLEAR_TRIGGER;
  if (/^(unclear|unknown|n\/?a|none|not clear|trigger unclear)$/i.test(s)) return UNCLEAR_TRIGGER;
  return s;
}

/**
 * §17/§21: an unknown vehicle count must stay unknown. Accepts a number, a numeric
 * string, or null/"unknown"/"" and returns a number or null — never a guess.
 */
export function normalizeVehicleCount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^(unknown|unclear|n\/?a|null|none)$/i.test(v.trim())) return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function isUnclearTrigger(v) {
  return normalizeTrigger(v) === UNCLEAR_TRIGGER;
}

/**
 * Validates and normalizes a raw triage object (typically parsed LLM JSON).
 * Returns { ok, value, errors } — the caller decides whether to retry or surface
 * a graceful error. We never silently invent a field that the model omitted.
 */
export function validateTriage(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, value: null, errors: ["Response was not a JSON object."] };
  }

  const nested = raw.severity && typeof raw.severity === "object" ? raw.severity : null;
  const flat = nested
    ? {
        ...raw,
        severity: nested.severity,
        severity_reason: nested.reason || nested.severity_reason || raw.severity_reason,
        source_fields_used: nested.source_fields_used || raw.source_fields_used,
      }
    : raw;

  const severity = normalizeSeverity(flat.severity);
  if (!severity) errors.push("severity must be one of P0, P1, P2, P3.");

  const str = (k, { required = true, max = 600 } = {}) => {
    const v = typeof flat[k] === "string" ? flat[k].trim() : "";
    if (!v && required) errors.push(`${k} is missing.`);
    return v.slice(0, max);
  };

  const subsystem = str("subsystem");
  const summary = str("summary", { max: 1200 });

  const reasonKeys = ["subsystem_reason", "severity_reason", "recovery_reason", "trigger_reason", "owner_reason"];
  const reasons = {};
  for (const k of reasonKeys) {
    const v = typeof flat[k] === "string" ? flat[k].trim() : "";
    if (v.length < 8) errors.push(`${k} is missing or too short to be evidence.`);
    reasons[k] = v.slice(0, 600);
  }

  if (errors.length) return { ok: false, value: null, errors };

  const used = Array.isArray(flat.source_fields_used)
    ? flat.source_fields_used.map((x) => String(x)).filter(Boolean)
    : [];

  return {
    ok: true,
    errors: [],
    value: {
      subsystem,
      subsystem_reason: reasons.subsystem_reason,
      severity,
      severity_reason: reasons.severity_reason,
      source_fields_used: used,
      recovery_path: normalizeRecovery(flat.recovery_path),
      recovery_reason: reasons.recovery_reason,
      trigger_condition: normalizeTrigger(flat.trigger_condition),
      trigger_reason: reasons.trigger_reason,
      suggested_owner: normalizeOwner(flat.suggested_owner),
      owner_reason: reasons.owner_reason,
      issue_type: normalizeIssueType(flat.issue_type),
      affected_vehicle_count: normalizeVehicleCount(flat.affected_vehicle_count),
      affected_vehicle_basis:
        typeof flat.affected_vehicle_basis === "string" ? flat.affected_vehicle_basis.trim().slice(0, 400) : "",
      summary,
    },
  };
}
