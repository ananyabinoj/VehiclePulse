/**
 * analyze.js — turns one raw report into an explainable triage decision.
 *
 * Two engines:
 *   Live    GROQ_API_KEY is set → real LLM (Groq), full rubric, corpus context (§1–§8, §18)
 *   Demo    no key → pre-generated analysis for known examples, else a labelled
 *           local baseline. Never presented as live AI (§24).
 *
 * A live failure is surfaced, never papered over with a fake result (§26). The API key
 * is read from the server environment only and never returned to the client (§2, §29).
 * Falls back to OPENAI_API_KEY if GROQ_API_KEY is not set.
 */
import {
  SEVERITIES,
  RECOVERY_PATHS,
  OWNERS,
  ISSUE_TYPES,
  UNCLEAR_TRIGGER,
  normalizeRecovery,
  normalizeTrigger,
  normalizeIssueType,
  normalizeVehicleCount,
  validateTriage,
} from "./rubric.js";
import { vehicleLabel } from "./nhtsa.js";

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

/** Raised when live analysis cannot produce a valid result. The report is never lost. */
export class LiveAnalysisError extends Error {
  constructor(message, { attempts = 1, detail = null } = {}) {
    super(message);
    this.name = "LiveAnalysisError";
    this.code = "LIVE_ANALYSIS_FAILED";
    this.attempts = attempts;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------- prompting */

const SYSTEM_PROMPT = `You are triaging automotive software support reports. Use evidence in the report, not keyword matching — words like "critical" or "failure" don't automatically mean P0.

Severity: P0 = safety risk or loss of vehicle control. P1 = many vehicles affected, major function unavailable, or recurring. P2 = limited impact, workaround exists. P3 = cosmetic, one-off, or an enhancement request.

Recovery: "OTA / Remote Recovery" only if the report implies software/remote fix. "Service Visit" only if it mentions physical repair, reflash at depot, or technician action. Otherwise "Unknown" — don't guess.

Trigger: extract only what the report actually states (overnight parking, specific version, low battery, etc). If not stated, say "Trigger unclear" and say what's missing.

Issue type: "Enhancement" if the user is requesting something new rather than reporting broken behavior — these should generally be P3 unless operational impact is stated.

Owner: pick from OTA Platform, Vehicle Software, Body Electronics, Infotainment, Connectivity, Telematics, Cloud Platform, Mobile App, Charging, Diagnostics, Field Engineering, Product Management.

Weight structured outcome fields over scary wording in the complaint text:
- deaths > 0 or fire = Y → push toward P0
- crash = Y or injured > 0 → push toward P1
- otherwise from the complaint: loss of braking/steering/control or a clearly recurring failure → P1; functional problem but the vehicle stays usable or a workaround exists → P2; cosmetic/minor/isolated → P3
Do not classify P0/P1 just because words like "failure" or "critical" appear, and do not classify P3 just because the tone is calm. Base it on the evidence in the fields.

Every field's *_reason must cite something actually in the report or structured fields — never write "this appears related to software" or similarly vague reasoning.

Return JSON with: subsystem, subsystem_reason, severity (P0|P1|P2|P3), severity_reason (one sentence citing evidence), source_fields_used (array of field names actually used, e.g. raw_complaint, crash, injured, fire, deaths), recovery_path ("OTA / Remote Recovery"|"Service Visit"|"Unknown"), recovery_reason, trigger_condition, trigger_reason, suggested_owner, owner_reason, issue_type ("Bug"|"Enhancement"), summary, similar_reports (array of up to 3 {id, similarity, reason}; empty if none are meaningfully similar). Use "Similar reports" language, not "Confirmed duplicates", unless two reports are near-certain copies of the same incident.`;

/** Compact corpus context — §18. Only the most relevant reports, never the whole corpus (§12). */
function contextBlock(similar = []) {
  if (!similar.length) return "";
  const lines = similar.slice(0, 5).map((s) => {
    const bits = [s.severity, s.recoveryPath || s.recovery_path]
      .filter(Boolean)
      .join(", ");
    const trig = s.triggerCondition || s.trigger_condition;
    const trigStr = trig && trig !== UNCLEAR_TRIGGER ? `, trigger: ${trig}` : "";
    const desc = String(s.shortDescription || s.triageSummary || s.rawText || "")
      .replace(/\s+/g, " ")
      .slice(0, 200);
    return `- ${s.id}${bits ? ` (${bits}${trigStr})` : ""}: ${desc}`;
  });
  return `
EXISTING REPORTS IN THIS CORPUS THAT LOOK RELATED (context only)
${lines.join("\n")}

Use these to judge whether the problem is recurring and how wide the impact appears to be. They are
retrieved by text similarity, so they may be irrelevant — do not copy their conclusions, and do not
raise severity just because the list is long. If they genuinely show the same failure repeating
across vehicles, say so in severity_reason.`;
}

/** Metadata we hold outside the narrative (imported rows carry make/model/component/etc.). */
function metadataBlock(meta = {}) {
  const rows = [
    ["Vehicle", vehicleLabel(meta)],
    ["Software version", meta.softwareVersion],
    ["Component (as filed)", meta.component],
    ["Reported occurrences", meta.occurrences],
    ["crash", meta.crash === true ? "Y" : meta.crash === false ? "N" : meta.crash],
    ["fire", meta.fire === true ? "Y" : meta.fire === false ? "N" : meta.fire],
    ["injured", meta.injured],
    ["deaths", meta.deaths],
    ["Source", meta.sourceType === "real" ? "Public NHTSA complaint (not an internal OEM ticket)" : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!rows.length) return "";
  return `\nKNOWN METADATA\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
}

function candidatesBlock(candidates = []) {
  if (!candidates.length) return "";
  const lines = candidates.map((c) => `- ${c.id} | ${c.subsystem || "?"} | ${c.summary}`);
  return `
CANDIDATE REPORTS (id | subsystem | one-line summary). Pick at most 3 similar_reports from this list only. If none are meaningfully similar, return [].
${lines.join("\n")}`;
}

function buildUserPrompt(text, { similar = [], candidates = [], metadata = {} } = {}) {
  return `${metadataBlock(metadata)}${contextBlock(similar)}${candidatesBlock(candidates)}

REPORT TO TRIAGE
"""
${String(text || "").slice(0, 12000)}
"""

Return the JSON object now.`;
}

/* ---------------------------------------------------------------- live analysis */

export async function llmJson(messages, apiKey, model) {
  const content = await chat(messages, apiKey, model);
  return parseJson(content);
}

async function chat(messages, apiKey, model) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty response.");
  return content;
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    // response_format should prevent this, but a fenced block is a cheap recovery.
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Response was not JSON.");
    return JSON.parse(m[0]);
  }
}

/**
 * One live analysis, with a single repair attempt. If the model returns something the
 * rubric rejects we hand back the exact validation errors and ask it to fix them —
 * that is far more reliable than guessing at the missing fields ourselves.
 */
export async function llmAnalyze(text, { apiKey, model, similar = [], candidates = [], metadata = {} } = {}) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(text, { similar, candidates, metadata }) },
  ];

  let lastErrors = null;
  let lastRaw = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let content;
    try {
      content = await chat(messages, apiKey, model);
    } catch (e) {
      // A transport/auth failure will not be fixed by retrying with the same key.
      throw new LiveAnalysisError(String(e.message || e), { attempts: attempt });
    }

    let raw;
    try {
      raw = parseJson(content);
    } catch (e) {
      lastErrors = [String(e.message || e)];
      lastRaw = content;
      messages.push({ role: "assistant", content: String(content).slice(0, 2000) });
      messages.push({ role: "user", content: "That was not valid JSON. Return only the JSON object." });
      continue;
    }

    const { ok, value, errors } = validateTriage(raw);
    if (ok) {
      return {
        ...value,
        similar_reports: normalizeSimilarFromLlm(raw.similar_reports, candidates),
        source: "llm",
        engine: model || DEFAULT_MODEL,
        severity_engine: "Live LLM",
        repaired: attempt > 1,
      };
    }

    lastErrors = errors;
    lastRaw = raw;
    messages.push({ role: "assistant", content: JSON.stringify(raw).slice(0, 2000) });
    messages.push({
      role: "user",
      content: `That response did not satisfy the rubric:\n${errors
        .map((e) => `- ${e}`)
        .join("\n")}\nReturn the corrected JSON object. Every *_reason must cite something specific from the report.`,
    });
  }

  throw new LiveAnalysisError("The model did not return a valid triage result.", {
    attempts: 2,
    detail: { errors: lastErrors, raw: typeof lastRaw === "string" ? lastRaw.slice(0, 400) : lastRaw },
  });
}

/* -------------------------------------------------- demo-mode local baseline */

const ENHANCEMENT_RE =
  /\b(asking if we can add|would be useful if|fleet manager wants|drivers are asking|enhancement|feature request|nice to have|can we get|would like the ability|request(ing)? (a|the) (option|ability|feature))\b/i;

/**
 * NHTSA component families → the vocabularies this product uses. Imported complaints
 * arrive with a filed component such as "ELECTRICAL SYSTEM" or
 * "FORWARD COLLISION AVOIDANCE: AUTOMATIC EMERGENCY BRAKING", which is far better
 * evidence of the affected area than anything inferable from consumer prose.
 *
 * Ordered: the first family whose pattern matches wins, so the more specific entries
 * come before the broad ones.
 */
const COMPONENT_MAP = [
  [/forward collision|automatic emergency braking|lane depart|blind spot|adaptive cruise|park assist|back over/i, "Driver Assistance (ADAS)", "Vehicle Software"],
  [/electronic stability|traction control|antilock|abs\b/i, "Brake Control", "Vehicle Software"],
  [/\bbrake/i, "Brakes", "Field Engineering"],
  [/\bsteering/i, "Steering", "Field Engineering"],
  [/power train|transmission|drivetrain|axle|driveshaft/i, "Powertrain", "Vehicle Software"],
  [/\bengine|fuel system|exhaust|cooling system/i, "Engine", "Vehicle Software"],
  [/electrical system|battery|starter|alternator|wiring/i, "Electrical System", "Body Electronics"],
  [/hybrid propulsion|electric propulsion|charging|charger/i, "Charging", "Charging"],
  [/air bag|seat belt|child seat|restraint/i, "Occupant Restraints", "Field Engineering"],
  [/\btire|wheel\b/i, "Tires and Wheels", "Field Engineering"],
  [/visibility|windshield|wiper|mirror|sun.?roof|glass/i, "Visibility", "Body Electronics"],
  [/exterior lighting|interior lighting|headlight|lighting/i, "Lighting", "Body Electronics"],
  [/latch|door|hood|trunk|lock/i, "Body Control Module", "Body Electronics"],
  [/seats?\b|structure|frame/i, "Body / Structure", "Field Engineering"],
  [/communication|radio|display|navigation|infotainment|audio|telematic/i, "Infotainment", "Infotainment"],
  [/suspension/i, "Suspension", "Field Engineering"],
  [/vehicle speed control|cruise control|accelerator/i, "Vehicle Speed Control", "Vehicle Software"],
];

/**
 * Resolves the FIRST cited component that maps to a known domain.
 *
 * A complaint filed against several components arrives as "ENGINE; SERVICE BRAKES;
 * FORWARD COLLISION AVOIDANCE…". Scanning the whole string against the table would let
 * the order this table happens to be written in decide the answer, which is meaningless.
 * Walking the cited components in the order they were filed at least uses the record's
 * own ordering, and the reason sentence names the component it actually used.
 *
 * Returns null — not a guess — when nothing resolves, including for NHTSA's catch-all
 * buckets ("UNKNOWN OR OTHER", "EQUIPMENT"). Callers then fall back to the narrative
 * rules instead of publishing a placeholder as if it were a finding (§17).
 */
function mapCitedComponent(cited) {
  for (const part of String(cited || "").split(";")) {
    const p = part.trim();
    if (!p) continue;
    for (const [re, subsystem, owner] of COMPONENT_MAP) {
      if (re.test(p)) return { subsystem, owner, matched: p };
    }
  }
  return null;
}

/** The component family actually used, lower-cased for use mid-sentence. */
function shortComponent(cited, matched) {
  const first = String(matched || String(cited || "").split(";")[0] || "").trim();
  const s = first.length > 46 ? `${first.slice(0, 44).trim()}…` : first;
  return s === s.toUpperCase() ? s.toLowerCase() : s;
}

export function heuristicAnalyze(text) {
  const t = String(text || "");
  const vehicleCount = extractCount(t);

  const enhancement = ENHANCEMENT_RE.test(t) && !/\b(fail|stall|crash|freeze|abort)\w*\b/i.test(t);
  const scaryWords =
    /\b(completely stopped|immobil|won't go|will not go|stranded|urgent|dangerous|fire|uncontrolled)\b/i.test(t);
  const harmlessCharge =
    /\bcompletely stopped\b/i.test(t) &&
    /\bcharg/i.test(t) &&
    /\b(ended normally|intentionally parked|pressed start|100%|no dtc)\b/i.test(t);

  const overnightOta =
    /\b(ota|campaign|update|reflash|bcm|body control)\b/i.test(t) &&
    /\b(overnight|parked overnight|sitting unused|cold soak|cold-soak)\b/i.test(t);

  const freeze = /\bfreez/i.test(t) && /\b(screen|infotainment|hu|head unit)\b/i.test(t);
  const isolatedTest = freeze && /\b(once|testing|lab|only seen on this|only one)\b/i.test(t);
  const fleetFreeze = freeze && vehicleCount >= 50;

  const staleApp = /\b(stale|lag|behind)\b/i.test(t) && /\b(app|status|location|soc)\b/i.test(t);
  const largeStale = staleApp && vehicleCount >= 100;

  const cellular = /\b(cellular|telematics|modem|backend connection|offline)\b/i.test(t);
  const chargingAbort = /\b(charg)\w*\b/i.test(t) && /\b(stop|abort|handshake)\b/i.test(t) && !harmlessCharge;
  const gateway = /\bgateway\b/i.test(t);
  const doorLock = /\b(door.?lock|sliding door)\b/i.test(t);
  const bluetooth = /\bbluetooth\b/i.test(t);
  const incomplete = t.trim().length < 80 || /\bno vin\b/i.test(t);

  /**
   * §6 — the difference between evidence and vocabulary.
   *
   * `recordedOutcome` reads the structured NHTSA outcome line that buildAnalysisText
   * emits from the CRASH / FIRE / INJURED / DEATHS columns. Those are recorded facts.
   * `controlLoss` requires a described loss of a control function *while the vehicle was
   * moving* — not the mere presence of "brake", "fire" or "safety" somewhere in the prose,
   * which is true of a large share of ordinary complaints and means nothing on its own.
   */
  const recordedOutcome = /Reported outcomes:[^\n]*?(crash reported|fire reported|\d+\s+injured|\d+\s+deaths)/i.test(t);
  const controlLoss =
    /\b(lost control|loss of (steering|braking|brakes|power steering)|brakes? (failed|went to the floor|stopped working)|unintended acceleration|accelerated on its own|stalled while (driving|in motion)|shut off while (driving|in motion)|steering (locked|seized))\b/i.test(t);
  /** A cited NHTSA component family, which is metadata rather than narrative wording. */
  const citedComponent = (t.match(/Component\(s\) cited:\s*([^\n]+)/i) || [])[1] || "";
  /**
   * A filed component family beats anything guessable from consumer prose, so it is
   * checked first — but only when it actually resolves to a domain. NHTSA's own
   * "UNKNOWN OR OTHER" / "EQUIPMENT" buckets resolve to null here so the narrative
   * rules below still get their turn.
   */
  const cited = citedComponent ? mapCitedComponent(citedComponent) : null;

  let subsystem = "Vehicle Software";
  let subsystem_reason =
    "No stronger domain signal than general vehicle software; using the full narrative rather than a single keyword.";

  if (cited) {
    subsystem = cited.subsystem;
    subsystem_reason = `The complaint record cites ${shortComponent(citedComponent, cited.matched)}, so the subsystem comes from the filed component rather than from wording in the narrative.`;
  } else if (overnightOta || (/\bcampaign\b/i.test(t) && /\b(bcm|ota|reflash)\b/i.test(t))) {
    subsystem = "OTA Update";
    subsystem_reason =
      "The narrative is about an update campaign stalling or failing to complete on a module, not about daily BCM features.";
  } else if (chargingAbort || harmlessCharge || /\bcharg/i.test(t)) {
    subsystem = "Charging";
    subsystem_reason = "The report is about a charging session, charge status, or EVSE handshake.";
  } else if (staleApp && !overnightOta) {
    subsystem = "Cloud Backend";
    subsystem_reason = "Vehicles are described as fine; the problem is delayed status in the app or fleet tool.";
  } else if (cellular) {
    subsystem = "Connectivity / Telematics";
    subsystem_reason = "The report describes losing backend/cellular connection or slow telematics re-attach.";
  } else if (freeze || bluetooth || /\bnav(igation)?\b/i.test(t)) {
    subsystem = "Infotainment";
    subsystem_reason = "Symptoms live on the head unit (display, BT, nav), not the powertrain.";
  } else if (gateway) {
    subsystem = "Vehicle Gateway";
    subsystem_reason = "Gateway / bus communication is the named fault.";
  } else if (doorLock) {
    subsystem = "Body Control Module";
    subsystem_reason = "Door-lock behavior is a BCM domain in this report.";
  } else if (/\bapp\b/i.test(t) && /\b(remote|lock command|location)\b/i.test(t)) {
    subsystem = "Mobile App";
    subsystem_reason = "Remote command or app presentation is the customer-facing failure.";
  } else if (incomplete) {
    subsystem = "Cloud Backend";
    subsystem_reason = "Too little vehicle evidence to assign an ECU; holding as unstructured intake.";
  }

  let severity = "P2";
  let severity_reason =
    "Defaulting to medium: a real complaint exists but fleet scale and safety are not clearly established.";

  if (harmlessCharge) {
    severity = "P3";
    severity_reason =
      "Alarming words are present, but the rest of the report explains a normal completed charge and a parked vehicle — not immobilization.";
  } else if (enhancement) {
    severity = "P3";
    severity_reason =
      "The writer is asking for a capability ('add', 'would be useful'), not describing a malfunction with customer harm.";
  } else if (isolatedTest) {
    severity = "P3";
    severity_reason =
      "A single freeze during testing that recovered is not a safety or fleet event, even if 'froze' sounds serious.";
  } else if (incomplete && vehicleCount <= 1) {
    severity = "P3";
    severity_reason = "The ticket does not contain enough evidence (model, count, logs) to justify a high severity.";
  } else if (recordedOutcome && !harmlessCharge) {
    severity = "P0";
    severity_reason =
      "The complaint record itself reports a crash, fire, injury or fatality. That is recorded outcome data, not alarming wording.";
  } else if (controlLoss && !harmlessCharge) {
    severity = "P0";
    severity_reason =
      "The narrative describes losing a control function (steering, braking or acceleration) while the vehicle was moving, which the rubric treats as an immediate safety risk.";
  } else if (overnightOta && (vehicleCount >= 10 || /\bpause the campaign|several depots|third time\b/i.test(t))) {
    severity = "P1";
    severity_reason =
      "Repeated OTA failures with fleet/depot impact and possible campaign pause — high operational disruption.";
  } else if (fleetFreeze || largeStale) {
    severity = vehicleCount >= 400 && staleApp ? "P2" : "P1";
    severity_reason = largeStale
      ? "Individually minor stale status, but the stated vehicle count is large enough that dispatch operations are affected (not P0: vehicles still work)."
      : "The same infotainment failure is described across a large fleet population, which the rubric treats as high.";
  } else if (vehicleCount <= 1 && /\bonly one unit|only one|one vehicle\b/i.test(t) && !controlLoss && !recordedOutcome) {
    severity = "P3";
    severity_reason = "The report itself limits impact to a single vehicle with no spreading language.";
  } else if (vehicleCount >= 80 && !enhancement) {
    severity = "P1";
    severity_reason =
      "A large stated vehicle count with a functional failure is treated as high even if each sentence is calm.";
  } else if (/\bworkaround|reboot|ignition cycle\b/i.test(t) && vehicleCount < 50) {
    severity = "P2";
    severity_reason = "A workaround exists and the population described is limited — medium unless safety appears.";
  }

  if (largeStale) {
    severity = "P2";
    severity_reason =
      "Not safety-critical, but hundreds of vehicles with stale status is significant operational disruption — higher than a single glitch, not P0.";
  }

  /**
   * A single imported consumer complaint that matched no specific rule. Say plainly that
   * the rule-based pass could not establish scale or safety, rather than dressing a
   * default up as a finding (§17/§18).
   */
  if (cited && severity === "P2" && severity_reason.startsWith("Defaulting to medium")) {
    severity = "P3";
    severity_reason = `One owner's complaint about ${shortComponent(citedComponent, cited.matched)} with no stated fleet impact and no recorded crash, fire or injury. Rule-based pass only — live analysis is needed to judge safety from the narrative.`;
  }

  let recovery_path = "Unknown";
  let recovery_reason =
    "The report does not clearly say whether remote tools or a technician visit actually recovered the vehicle.";
  if (/\b(reflash|workshop|bay|depot|scan tool|module programming|replaced the display|windshield)\b/i.test(t)) {
    recovery_path = "Service Visit";
    recovery_reason = "Recovery described in the text required a person with service tools or a depot flash, not the app alone.";
  } else if (/\b(remote|reboot|ignition cycle|backend reset|rolled .* back remotely|app refresh)\b/i.test(t)) {
    recovery_path = "OTA / Remote Recovery";
    recovery_reason = "The write-up says the condition cleared with remote action, reboot, or ignition cycle.";
  } else if (enhancement || harmlessCharge) {
    recovery_path = "Unknown";
    recovery_reason = "No incident recovery applies, so no recovery path is claimed.";
  }

  let trigger_condition = UNCLEAR_TRIGGER;
  let trigger_reason = "The report does not pin a reproducible condition (sleep, coverage, version, charge, etc.).";
  if (/\bovernight|sitting unused|cold soak\b/i.test(t)) {
    trigger_condition = "Vehicle parked overnight before OTA campaign";
    trigger_reason = "The author ties the failure to vehicles that sat unused overnight.";
  } else if (/\b5\.0\.1|4\.2\.1|4\.2\.0|started after campaign|after 4\./i.test(t)) {
    trigger_condition = "Specific software version";
    trigger_reason = "Timing is described relative to a software version or campaign.";
  } else if (/\bdesert|coverage|dead zone|cellular drops\b/i.test(t)) {
    trigger_condition = "Poor cellular connectivity";
    trigger_reason = "Geography / RF coverage is called out as the condition.";
  } else if (/\bfast charg|dc\b/i.test(t) && /\bcharg/i.test(t)) {
    trigger_condition = "Fast charging session";
    trigger_reason = "The abort is tied to a DC/fast charge session.";
  } else if (/\bsleep mode\b/i.test(t)) {
    trigger_condition = "Vehicle entering sleep mode";
    trigger_reason = "Sleep/wake is explicitly mentioned.";
  } else if (harmlessCharge) {
    trigger_condition = "End of charging session";
    trigger_reason = "The vehicle was stationary because charging finished, not because it was disabled.";
  } else if (enhancement) {
    trigger_reason = "Enhancement requests do not have a failure trigger.";
  }

  const ownerMap = {
    "OTA Update": ["OTA Platform", "The defect shows up during campaign delivery rather than as a standalone ECU feature bug."],
    "Body Control Module": ["Body Electronics", "Door/lighting/BCM configuration is the named domain."],
    Infotainment: ["Infotainment", "Head-unit behavior is the customer symptom."],
    "Connectivity / Telematics": ["Connectivity", "Modem / backend attach is the failure mode."],
    Charging: ["Charging", "EV charging session or status is the subject."],
    "Vehicle Gateway": ["Vehicle Software", "Gateway software/dataset after a release."],
    "Mobile App": ["Mobile App", "Customer-facing remote command or presentation."],
    "Cloud Backend": ["Cloud Platform", "Status freshness or fleet-tool data, not the ECU."],
    ADAS: ["Vehicle Software", "ADAS calibration/config on a single model."],
    Powertrain: ["Diagnostics", "Driveability without enough evidence — diagnostics first."],
  };
  let suggested_owner = ownerMap[subsystem]?.[0] || "Field Engineering";
  let owner_reason = ownerMap[subsystem]?.[1] || "Needs a named engineering owner after evidence is complete.";
  if (cited) {
    // The filed component decides the routing for imported complaints, for the same
    // reason it decided the subsystem: it is recorded metadata, not inferred wording.
    suggested_owner = cited.owner;
    owner_reason = `Routed from the filed component (${shortComponent(citedComponent, cited.matched)}); this is a single owner complaint, so the receiving team should confirm scope before escalating.`;
  }
  if (enhancement) {
    suggested_owner = "Product Management";
    owner_reason = "This is a capability request, not an incident assignment to an ECU team.";
  }
  if (incomplete) {
    suggested_owner = "Field Engineering";
    owner_reason = "Complete the ticket (VIN, model, software, logs) before assigning an ECU team.";
  }

  const summary = buildSummary({
    severity,
    subsystem,
    overnightOta,
    enhancement,
    harmlessCharge,
    largeStale,
    vehicleCount,
    recovery_path,
  });

  return {
    subsystem,
    subsystem_reason,
    severity,
    severity_reason,
    recovery_path: normalizeRecovery(recovery_path),
    recovery_reason,
    trigger_condition: normalizeTrigger(trigger_condition),
    trigger_reason,
    suggested_owner,
    owner_reason,
    issue_type: enhancement ? "Enhancement" : "Bug",
    // §17/§21 — an unstated count stays null. extractCount returns 0 when it found nothing.
    affected_vehicle_count: vehicleCount > 0 ? vehicleCount : null,
    affected_vehicle_basis: vehicleCount > 0 ? "Count read from a number stated in the report text." : "",
    summary,
    source: "heuristic",
  };
}

function buildSummary({
  severity,
  subsystem,
  overnightOta,
  enhancement,
  harmlessCharge,
  largeStale,
  vehicleCount,
  recovery_path,
}) {
  if (harmlessCharge) {
    return "Not a stranded-vehicle event. Wording is alarming, but the evidence is a finished charge and a parked car. Do not escalate as P0.";
  }
  if (enhancement) {
    return "This reads as a product enhancement. Keep it on the backlog; it is not a campaign-blocking incident on its own.";
  }
  if (overnightOta) {
    return "High-priority OTA update reliability issue if the fleet count holds. Investigate campaign behavior after overnight vehicle sleep before continuing the rollout.";
  }
  if (largeStale) {
    return "Looks like a small app issue. Evidence is a large number of vehicles with stale status. Prioritize as fleet-tooling reliability.";
  }
  return `${severity} ${subsystem} report (about ${vehicleCount || "an unknown number of"} vehicles). Recovery appears to be ${recovery_path}. Review the reasons before escalating.`;
}

function extractCount(text) {
  const patterns = [
    /\b(\d{2,5})\s+(?:vans|vehicles|units|cars|suvs|tickets|helix|apex|ridge|couriers)\b/i,
    /\bacross\s+(\d{2,5})\b/i,
    /\bcounted\s+(\d{2,5})\b/i,
    /\b(\d{2,5})\s+this (?:week|morning)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return Number(m[1]);
  }
  if (/\b(hundreds)\b/i.test(text)) return 200;
  if (/\bonly one unit|one vehicle|one unit so far\b/i.test(text)) return 1;
  return 0;
}

/** Brings a pre-generated demo result onto the current rubric without editing seed text. */
function normalizeDemoResult(result) {
  return {
    ...result,
    recovery_path: normalizeRecovery(result.recovery_path),
    trigger_condition: normalizeTrigger(result.trigger_condition),
    issue_type: result.issue_type || normalizeIssueType(result.summary),
    affected_vehicle_count: normalizeVehicleCount(result.affected_vehicle_count),
    affected_vehicle_basis: result.affected_vehicle_basis || "",
  };
}

/* --------------------------------------------------------------------- entry */

/**
 * Analyzes one report.
 *
 * With an API key this always runs the live LLM — a matching demo example no longer
 * short-circuits real analysis (§1). Without a key it returns a clearly-labelled
 * pre-generated result, or the local baseline.
 *
 * Throws LiveAnalysisError if live analysis fails, so the caller can tell the user the
 * truth instead of showing an invented result (§26).
 */
function normalizeSimilarFromLlm(raw, candidates = []) {
  const allowed = new Set(candidates.map((c) => c.id));
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && s.id && (!allowed.size || allowed.has(s.id)))
    .slice(0, 3)
    .map((s) => ({
      id: String(s.id),
      similarity: Math.max(0, Math.min(100, Number(s.similarity) || 0)),
      reason: String(s.reason || "Overlapping subsystem and summary with the new report."),
      relation: Number(s.similarity) >= 90 ? "Possible duplicate — verify" : "Similar report",
      shortDescription: candidates.find((c) => c.id === s.id)?.summary || "",
    }));
}

function ynFlag(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "Y" || s === "YES" || s === "TRUE" || s === "1";
}

function numFlag(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pull crash/fire/injured/deaths from metadata, imported raw rows, or outcome lines in the text. */
export function extractStructuredFields(text, metadata = {}) {
  const row = firstRawRow(metadata.raw || metadata.raw_data);
  const t = String(text || "");
  const crash = ynFlag(metadata.crash ?? row.CRASH ?? row.crash) || /Reported outcomes:[^\n]*crash reported/i.test(t);
  const fire = ynFlag(metadata.fire ?? row.FIRE ?? row.fire) || /Reported outcomes:[^\n]*fire reported/i.test(t);
  const injured = numFlag(metadata.injured ?? row.INJURED ?? row.injured);
  const deaths = numFlag(metadata.deaths ?? row.DEATHS ?? row.deaths);
  const injuredFromText = t.match(/Reported outcomes:[^\n]*?(\d+)\s+injured/i);
  const deathsFromText = t.match(/Reported outcomes:[^\n]*?(\d+)\s+deaths/i);
  const complaint = String(
    metadata.raw_complaint || metadata.description || row.CDESCR || row.cdescr || text || ""
  );
  return {
    crash,
    fire,
    injured: injured || (injuredFromText ? Number(injuredFromText[1]) : 0),
    deaths: deaths || (deathsFromText ? Number(deathsFromText[1]) : 0),
    raw_complaint: complaint,
  };
}

function firstRawRow(raw) {
  if (!raw) return {};
  if (Array.isArray(raw.rows) && raw.rows[0]) return raw.rows[0];
  if (raw.FIRE !== undefined || raw.CRASH !== undefined || raw.CDESCR) return raw;
  return {};
}

/**
 * Deterministic severity when the LLM is missing or fails.
 * Never returns P3 — unknown/unanalyzed is P2, not the lowest tier.
 */
export function ruleBasedSeverity(fields) {
  const c = String(fields.raw_complaint || "").toLowerCase();
  const used = [];
  if (fields.deaths > 0 || fields.fire) {
    if (fields.deaths > 0) used.push("deaths");
    if (fields.fire) used.push("fire");
    if (c) used.push("raw_complaint");
    return {
      severity: "P0",
      reason:
        fields.deaths > 0
          ? `Structured field deaths=${fields.deaths} is greater than zero.`
          : "Structured field fire=Y.",
      source_fields_used: used,
    };
  }
  if (fields.crash || fields.injured > 0) {
    if (fields.crash) used.push("crash");
    if (fields.injured > 0) used.push("injured");
    if (c) used.push("raw_complaint");
    return {
      severity: "P1",
      reason: fields.crash
        ? "Structured field crash=Y."
        : `Structured field injured=${fields.injured} is greater than zero.`,
      source_fields_used: used,
    };
  }
  const p1 = ["brake failure", "steering failed", "lost control", "stall", "won't stop", "wont stop", "locked up"];
  const hit1 = p1.find((k) => c.includes(k));
  if (hit1) {
    return {
      severity: "P1",
      reason: `Complaint text contains "${hit1}".`,
      source_fields_used: ["raw_complaint"],
    };
  }
  const p2 = ["intermittent", "malfunction", "noise", "doesn't work properly", "doesnt work properly"];
  const hit2 = p2.find((k) => c.includes(k));
  if (hit2) {
    return {
      severity: "P2",
      reason: `Complaint text contains "${hit2}".`,
      source_fields_used: ["raw_complaint"],
    };
  }
  return {
    severity: "P2",
    reason: "No structured safety flags and no high-severity phrases; defaulting to P2 rather than P3 because analysis did not complete.",
    source_fields_used: c ? ["raw_complaint"] : [],
  };
}

function withRuleSeverity(base, fields, { notice = true } = {}) {
  const sev = ruleBasedSeverity(fields);
  return {
    ...base,
    severity: sev.severity,
    severity_reason: sev.reason,
    source_fields_used: sev.source_fields_used,
    source: "fallback-rules",
    mode: "fallback",
    severity_engine: "Fallback · Rule-based",
    notice: notice ? "Live analysis unavailable, showing rule-based result" : undefined,
  };
}

export async function analyzeReport(text, { apiKey, model, similar = [], candidates = [], metadata = {} } = {}) {
  const fields = extractStructuredFields(text, metadata);

  if (apiKey) {
    try {
      const triage = await llmAnalyze(text, { apiKey, model, similar, candidates, metadata: { ...metadata, ...fields } });
      return {
        ...triage,
        mode: "live",
        severity_engine: "Live LLM",
        source_fields_used: triage.source_fields_used?.length ? triage.source_fields_used : inferUsed(fields),
      };
    } catch (e) {
      console.error("[VehiclePulse] LLM analysis failed:", e);
      return withRuleSeverity(heuristicAnalyze(text), fields);
    }
  }

  return withRuleSeverity(heuristicAnalyze(text), fields);
}

function inferUsed(fields) {
  const u = [];
  if (fields.deaths > 0) u.push("deaths");
  if (fields.fire) u.push("fire");
  if (fields.crash) u.push("crash");
  if (fields.injured > 0) u.push("injured");
  if (fields.raw_complaint) u.push("raw_complaint");
  return u;
}
