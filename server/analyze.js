import { matchDemoExample } from "./demoExamples.js";

const ENHANCEMENT_RE =
  /\b(asking if we can add|would be useful if|fleet manager wants|drivers are asking|enhancement|feature request|nice to have)\b/i;

export function heuristicAnalyze(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const vehicleCount = extractCount(t);

  const enhancement = ENHANCEMENT_RE.test(t) && !/\b(fail|stall|crash|freeze|abort)\w*\b/i.test(t);
  const scaryWords = /\b(completely stopped|immobil|won't go|will not go|stranded|urgent|dangerous|fire|uncontrolled)\b/i.test(t);
  const harmlessCharge =
    scaryWords &&
    /\b(charge|charging|soc|unplugged|session had ended|ended normally)\b/i.test(t) &&
    /\b(no dtc|not escalate|pressed start|100%)\b/i.test(t);

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

  let subsystem = "Vehicle Software";
  let subsystem_reason = "No stronger domain signal than general vehicle software; using the full narrative rather than a single keyword.";

  if (overnightOta || (/\bcampaign\b/i.test(t) && /\b(bcm|ota|reflash)\b/i.test(t))) {
    subsystem = "OTA Update";
    subsystem_reason = "The narrative is about an update campaign stalling or failing to complete on a module, not about daily BCM features.";
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
  let severity_reason = "Defaulting to medium: a real complaint exists but fleet scale and safety are not clearly established.";

  if (harmlessCharge) {
    severity = "P3";
    severity_reason =
      "Alarming words are present, but the rest of the report explains a normal completed charge and a parked vehicle — not immobilization.";
  } else if (enhancement) {
    severity = "P3";
    severity_reason = "The writer is asking for a capability ('add', 'would be useful'), not describing a malfunction with customer harm.";
  } else if (isolatedTest) {
    severity = "P3";
    severity_reason = "A single freeze during testing that recovered is not a safety or fleet event, even if 'froze' sounds serious.";
  } else if (incomplete && vehicleCount <= 1) {
    severity = "P3";
    severity_reason = "The ticket does not contain enough evidence (model, count, logs) to justify a high severity.";
  } else if (
    /\b(safety|airbag|unintended acceleration|brake|fire|immobilized while driving)\b/i.test(t) &&
    !harmlessCharge
  ) {
    severity = "P0";
    severity_reason = "The narrative includes potential safety or dangerous vehicle behavior, which the rubric maps to P0 pending disproof.";
  } else if (overnightOta && (vehicleCount >= 10 || /\bpause the campaign|several depots|third time\b/i.test(t))) {
    severity = "P1";
    severity_reason = "Repeated OTA failures with fleet/depot impact and possible campaign pause — high operational disruption.";
  } else if (fleetFreeze || largeStale) {
    severity = vehicleCount >= 400 && staleApp ? "P2" : "P1";
    severity_reason = largeStale
      ? "Individually minor stale status, but the stated vehicle count is large enough that dispatch operations are affected (not P0: vehicles still work)."
      : "The same infotainment failure is described across a large fleet population, which the rubric treats as high.";
  } else if (vehicleCount <= 1 && /\bonly one unit|only one|one vehicle\b/i.test(t) && !/\bsafety\b/i.test(t)) {
    severity = "P3";
    severity_reason = "The report itself limits impact to a single vehicle with no spreading language.";
  } else if (vehicleCount >= 80 && !enhancement) {
    severity = "P1";
    severity_reason = "A large stated vehicle count with a functional failure is treated as high even if each sentence is calm.";
  } else if (/\bworkaround|reboot|ignition cycle\b/i.test(t) && vehicleCount < 50) {
    severity = "P2";
    severity_reason = "A workaround exists and the population described is limited — medium unless safety appears.";
  }

  if (largeStale) {
    severity = "P2";
    severity_reason =
      "Not safety-critical, but hundreds of vehicles with stale status is significant operational disruption — higher than a single glitch, not P0.";
  }

  let recovery_path = "Unknown";
  let recovery_reason = "The report does not clearly say whether remote tools or a technician visit actually recovered the vehicle.";
  if (/\b(reflash|workshop|bay|depot|scan tool|module programming|replaced the display|windshield)\b/i.test(t)) {
    recovery_path = "Technician / Service Visit";
    recovery_reason = "Recovery described in the text required a person with service tools or a depot flash, not the app alone.";
  } else if (/\b(remote|reboot|ignition cycle|backend reset|rolled .* back remotely|app refresh)\b/i.test(t)) {
    recovery_path = "OTA / Remote Recovery";
    recovery_reason = "The write-up says the condition cleared with remote action, reboot, or ignition cycle.";
  } else if (enhancement || harmlessCharge) {
    recovery_path = "Unknown";
    recovery_reason = "No incident recovery applies.";
  }

  let trigger_condition = "Unclear";
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
    trigger_reason = "The vehicle was stationary because charging completed.";
  } else if (enhancement) {
    trigger_reason = "Enhancement requests do not have a failure trigger.";
  }

  const ownerMap = {
    "OTA Update": ["OTA Platform", "The defect shows up during campaign delivery rather than as a standalone ECU feature bug."],
    "Body Control Module": ["Body Electronics", "Door/lighting/BCM configuration is the named domain."],
    "Infotainment": ["Infotainment", "Head-unit behavior is the customer symptom."],
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
    recovery_path,
    recovery_reason,
    trigger_condition,
    trigger_reason,
    suggested_owner,
    owner_reason,
    summary,
    source: "heuristic",
  };
}

function buildSummary({ severity, subsystem, overnightOta, enhancement, harmlessCharge, largeStale, vehicleCount, recovery_path }) {
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

export async function llmAnalyze(text, apiKey, model) {
  const prompt = `You are assisting OEM support engineers. Return JSON only.
Classify this vehicle software support report using FULL CONTEXT (fleet size, safety, workaround, frequency, service vs remote, spreading). Do NOT assign P0/P1 just because of scary words if the rest of the text contradicts them. Isolated test freezes are not critical. Enhancement requests are usually P3.

Severity:
P0 Critical: safety, immobilization while in use, major security, dangerous behavior
P1 High: large fleet, repeated failures, major function down, significant ops disruption
P2 Medium: limited impact, workaround exists, smaller population
P3 Low: minor, cosmetic, isolated, enhancement

recovery_path must be exactly one of: "OTA / Remote Recovery" | "Technician / Service Visit" | "Unknown"

subsystem examples: OTA Update, Body Control Module, Infotainment, Connectivity / Telematics, Powertrain, ADAS, Charging, Vehicle Gateway, Mobile App, Cloud Backend

suggested_owner examples: OTA Platform, Vehicle Software, Body Electronics, Infotainment, Connectivity, Telematics, Cloud Platform, Mobile App, Charging, Diagnostics, Field Engineering, Product Management

Every *_reason field is one sentence explaining WHY.

JSON keys:
subsystem, subsystem_reason, severity (P0|P1|P2|P3), severity_reason, recovery_path, recovery_reason, trigger_condition, trigger_reason, suggested_owner, owner_reason, summary (non-technical triage recommendation)

Report:
"""${text}"""`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You return only valid JSON for VehiclePulse triage." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${err.slice(0, 400)}`);
  }
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return { ...parsed, source: "llm" };
}

export async function analyzeReport(text, { apiKey, model }) {
  const demo = matchDemoExample(text);
  if (demo) {
    return { ...demo.result, source: "demo-example", demoExampleId: demo.id };
  }
  if (apiKey) {
    try {
      return await llmAnalyze(text, apiKey, model);
    } catch (e) {
      const h = heuristicAnalyze(text);
      h.source = "heuristic-fallback";
      h.fallbackError = String(e.message || e);
      return h;
    }
  }
  return heuristicAnalyze(text);
}
