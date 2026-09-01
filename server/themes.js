import { SEVERITY_WEIGHTS } from "./seed.js";

export function buildThemes(reports) {
  const groups = new Map();
  for (const r of reports) {
    const key = r.theme || "Ungrouped";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const themes = [];
  for (const [name, items] of groups) {
    const affectedVehicles = items.reduce((s, r) => s + (Number(r.affectedVehicles) || 0), 0);
    const dist = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const r of items) dist[r.severity] = (dist[r.severity] || 0) + 1;

    const order = ["P0", "P1", "P2", "P3"];
    let themeSeverity = "P3";
    for (const sev of order) {
      if (dist[sev] > 0) {
        themeSeverity = sev;
        break;
      }
    }
    // Prefer vehicle-weighted severity when P0/P1 are absent but volume is P2/P3
    const weighted = items.reduce((s, r) => s + (Number(r.affectedVehicles) || 0) * (SEVERITY_WEIGHTS[r.severity] || 1), 0);
    const priorityScore = Math.round(affectedVehicles * (SEVERITY_WEIGHTS[themeSeverity] || 1));

    const triggers = countField(items, "triggerCondition");
    const recoveries = countField(items, "recoveryPath");
    const models = [...new Set(items.map((r) => r.vehicleModel))];
    const versions = [...new Set(items.map((r) => r.softwareVersion))];
    const owners = [...new Set(items.map((r) => r.suggestedOwner))];
    const subsystems = [...new Set(items.map((r) => r.subsystem))];

    themes.push({
      id: slug(name),
      name,
      priorityScore,
      vehicleWeightedScore: Math.round(weighted),
      affectedVehicles,
      severity: themeSeverity,
      reportCount: items.length,
      severityDistribution: dist,
      reportIds: items.map((r) => r.id),
      reports: items,
      commonTriggers: triggers,
      commonRecovery: recoveries,
      models,
      versions,
      owners,
      subsystems,
      whyItMatters: whyItMatters(name, items, affectedVehicles, themeSeverity),
      seeing: whatWereSeeing(name, items),
      productImprovement: productImprovement(name),
      description: themeDescription(name),
    });
  }

  themes.sort((a, b) => b.priorityScore - a.priorityScore || b.affectedVehicles - a.affectedVehicles);
  return themes;
}

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function countField(items, field) {
  const m = new Map();
  for (const r of items) {
    const k = r[field] || "Unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

function themeDescription(name) {
  const map = {
    "OTA Updates Failing After Vehicle Sleep":
      "Multiple fleets report OTA campaigns failing or stalling after vehicles remain parked overnight.",
    "Infotainment Freeze After 4.2.0":
      "Head-unit freeze after recent software, spanning a large Ridge fleet and a Helix regression set.",
    "Intermittent Cellular / Telematics Drops":
      "Vans lose backend connectivity in weak-coverage regions and after deep sleep, then reconnect slowly.",
    "Stale Vehicle Status in Mobile App":
      "App and fleet tools show delayed SOC/location even though the vehicles themselves are operating.",
    "High-Volume Low-Severity Audio Hiss":
      "A faint Bluetooth pause hiss generating a very large number of low-severity retail tickets.",
    "DC Charge Session Stops Unexpectedly":
      "DC fast-charge sessions abort mid-session on Volt Hatch, sometimes needing a bay reset.",
    "Stale Charging Status After Unplug":
      "Charging state remains 'charging' after the cable is removed.",
    "Gateway Faults After 4.2.1":
      "Gateway communication and config issues after the 4.2.x software drop.",
    "BCM Door-Lock Behavior After Update":
      "Door-lock status and physical lock state disagree after the BCM package.",
    "5.0.1-beta Version-Specific OTA Defect":
      "Pilot 5.0.1-beta fails package verify; rollback to 4.2.1 recovers units.",
  };
  return map[name] || `Recurring reports grouped as: ${name}.`;
}

function whyItMatters(name, items, vehicles, sev) {
  if (name.includes("OTA Updates Failing")) {
    return "Campaign 4.2.1 is consuming depot labor and fleets are already asking to pause rollout. This is a product reliability issue, not a pile of unrelated tickets.";
  }
  if (name.includes("Stale Vehicle Status")) {
    return "Each ticket sounds minor, but hundreds of vans with stale status change how dispatch runs. Volume × operational drag is the story.";
  }
  if (name.includes("Audio Hiss")) {
    return "Not urgent per vehicle, but the ticket volume will dominate care queues and NPS comments until it is scheduled as a polish fix.";
  }
  if (name.startsWith("Enhancement")) {
    return "These are product asks, not defects. They should stay visible so they are not lost, without jumping the incident queue.";
  }
  if (name.includes("Harmless")) {
    return "This cluster exists so scary wording is not auto-escalated. It is a training example for the triage rubric.";
  }
  if (name.includes("Incomplete")) {
    return "Incomplete tickets waste engineering time if they are treated as facts. The action is evidence collection.";
  }
  return `${vehicles} estimated affected vehicles at peak severity ${sev} across ${items.length} reports.`;
}

function whatWereSeeing(name, items) {
  if (name.includes("OTA Updates Failing")) {
    return [
      "Update stalls around 50–70% on the BCM package",
      "Mostly occurs after overnight parking / cold soak",
      "Depot reflashing or keep-awake often resolves the issue",
      "Reports span Apex, Ridge, and Courier — not one wiring harness",
    ];
  }
  if (name.includes("Infotainment Freeze After")) {
    return [
      "Screen locks mid-route; reboot or ignition cycle recovers",
      "Large Ridge 4.2.0 population plus Helix 4.2.1 regression signal",
      "Not the rodent/water hardware one-off",
    ];
  }
  if (name.includes("Cellular")) {
    return [
      "Drops in weak-coverage corridors (desert US, rural ES)",
      "Telematics takes minutes to re-attach",
      "Some weekend-sit cases recover with a remote modem reset",
    ];
  }
  if (name.includes("Stale Vehicle Status")) {
    return [
      "Dispatchers describe it as 'one van looks stale'",
      "National count is hundreds of units",
      "On-vehicle data is current; cloud/app lag",
    ];
  }
  if (name.includes("Audio Hiss")) {
    return ["Hiss after Bluetooth pause", "Helix 4.1.8 retail volume is very large", "No immobilization or function loss"];
  }
  const bits = [];
  const trig = items[0]?.triggerCondition;
  if (trig) bits.push(`Common trigger: ${trig}`);
  bits.push(`${items.length} contributing reports`);
  return bits;
}

function productImprovement(name) {
  const map = {
    "OTA Updates Failing After Vehicle Sleep":
      "Improve OTA campaign resilience after ECU sleep states and provide clearer rollout health monitoring so stalled BCM packages are visible before fleets ask to pause.",
    "Infotainment Freeze After 4.2.0":
      "Ship a head-unit stability fix for 4.2.x, add fleet-level freeze telemetry, and block similar regressions on Helix with a release-gate test.",
    "Intermittent Cellular / Telematics Drops":
      "Harden modem re-attach after coverage loss and deep sleep, and expose reconnect-time metrics to fleet tools.",
    "Stale Vehicle Status in Mobile App":
      "Fix cloud status freshness (cache TTL / ingest lag) and show 'last updated' clearly so dispatch does not treat stale pins as truth.",
    "High-Volume Low-Severity Audio Hiss":
      "Schedule a DSP/EQ polish for Helix Bluetooth idle noise; treat it as a care-volume problem, not an incident war-room.",
    "DC Charge Session Stops Unexpectedly":
      "Improve DC handshake robustness and publish a clearer fault reason to the driver and fleet tool when a session aborts.",
    "Stale Charging Status After Unplug":
      "End cloud charging state when onboard session ends; do not wait for a later ignition cycle.",
    "Delayed Remote Lock Commands":
      "Reduce remote-command queue latency and surface an honest 'sending…' state instead of a silent wait.",
    "Gateway Faults After 4.2.1":
      "Add post-OTA gateway dataset verification and a remote recovery path before requiring a workshop flash.",
    "BCM Door-Lock Behavior After Update":
      "Preserve lock configuration across BCM updates and add a status-consistency check between app and latch.",
    "Lighting Configuration Resets":
      "Persist customer lighting profiles across software updates instead of reverting to factory coding.",
    "Bluetooth Drops After Phone Reconnect":
      "Fix BT re-pairing after phones leave and re-enter range; avoid requiring forget-and-pair.",
    "Stale Navigation Map Data":
      "Make map tile refresh reliable after 4.2.0 and allow a remote map package push.",
    "5.0.1-beta Version-Specific OTA Defect":
      "Halt 5.0.1-beta, fix package verify, and keep rollback as a documented remote recovery.",
    "Enhancement: OTA Progress Visibility":
      "Show ECU-level OTA progress and stuck-step identity in the app and fleet console.",
    "Enhancement: Scheduled OTA Windows":
      "Let fleets schedule and stagger campaign windows by depot timezone.",
    "Enhancement: Fleet-Level Alerts":
      "Page once when many vehicles share an OTA error, not once per VIN email.",
    "Enhancement: Detailed Charging Status":
      "Expose power, remaining time, and handshake fault text during charge sessions.",
    "Isolated OTA Failures":
      "Keep isolated dealer fails in a holding pattern until they match a campaign signature.",
    "Infotainment Freeze (Isolated)":
      "Do not merge one-off lab freezes into the fleet freeze program without matching logs.",
    "One-off Hardware Display Fault":
      "Keep hardware water/cable failures out of software freeze metrics.",
    "Harmless Charge-Complete Misread":
      "Train intake to separate 'vehicle stationary after a completed charge' from immobilization.",
    "Incomplete / Unclear Field Reports":
      "Require VIN, model, software, and a minimum symptom template before engineering assignment.",
    "ADAS Calibration — Volt Hatch Only":
      "Publish the windshield-replacement calibration path for Volt Hatch; do not generalize to other models yet.",
  };
  return map[name] || "Translate this cluster into a product backlog item with owner, success metric, and fleet impact — not another copy of the raw symptom.";
}

export function dashboardStats(reports, themes) {
  const totalReports = reports.length;
  const vehiclesAffected = reports.reduce((s, r) => s + (Number(r.affectedVehicles) || 0), 0);
  const highCritical = reports.filter((r) => r.severity === "P0" || r.severity === "P1").length;
  const recurringThemes = themes.filter((t) => t.reportCount >= 1).length;
  return { totalReports, vehiclesAffected, highCritical, recurringThemes };
}
