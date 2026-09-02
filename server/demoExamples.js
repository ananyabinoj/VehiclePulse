export const DEMO_EXAMPLES = [
  {
    id: "demo-ota-verify",
    title: "OTA stall (short)",
    text: "Fleet ops says campaign 4.2.1 stalls around 60% on the BCM after vehicles sit overnight. Depot technicians have reflashed three units this month. Fleet is asking whether to pause the rollout.",
    result: {
      subsystem: "OTA Update",
      subsystem_reason: "The report names campaign 4.2.1 stalling on the BCM, which is an OTA delivery failure.",
      severity: "P1",
      severity_reason: "Three units reflashed this month and the fleet is asking whether to pause the rollout — recurring fleet impact, not a one-off freeze.",
      recovery_path: "Service Visit",
      recovery_reason: "Depot technicians have reflashed units; that is physical service, not a remote recovery.",
      trigger_condition: "Vehicle parked overnight before OTA campaign",
      trigger_reason: "The report says the stall happens after vehicles sit overnight.",
      suggested_owner: "OTA Platform",
      owner_reason: "The failure is during campaign 4.2.1 on the BCM step, not normal body operation.",
      issue_type: "Bug",
      affected_vehicle_count: 3,
      affected_vehicle_basis: "three units this month",
      summary: "P1 OTA reliability issue after overnight sit. Pause discussion is justified until resume-after-sleep is understood.",
    },
  },
  {
    id: "demo-ota-overnight",
    title: "OTA stall after overnight parking",
    text: "Customer fleet ops says update campaign 4.2.1 stalls around 60% on the body control module. Only on units that were parked overnight. Their tech cleared it by reflashing at the depot. Third time this month, they are asking whether they should pause the campaign.",
    result: {
      subsystem: "OTA Update",
      subsystem_reason:
        "The report describes campaign 4.2.1 stalling while communicating with the body control module, which is an update-delivery failure.",
      severity: "P1",
      severity_reason:
        "Repeated update failures are affecting multiple fleet vehicles and may require pausing an update campaign — high operational impact, not a one-off.",
      recovery_path: "Technician / Service Visit",
      recovery_reason:
        "The report says technicians had to reflash the vehicle at the depot, so remote recovery does not appear sufficient.",
      trigger_condition: "Vehicle parked overnight before OTA campaign",
      trigger_reason: "Failures are described only on units that sat unused overnight, not on the general population.",
      suggested_owner: "OTA Platform",
      owner_reason:
        "The failure occurs during an OTA campaign and appears related to update delivery rather than normal BCM operation.",
      issue_type: "Bug",
      // The report says "third time this month" but never states how many vehicles —
      // so this stays unknown rather than being turned into a number (§17).
      affected_vehicle_count: null,
      affected_vehicle_basis: "",
      summary:
        "High-priority OTA update reliability issue. Similar failures appear across multiple fleet reports. Investigate campaign 4.2.1 behavior after overnight vehicle sleep before continuing the rollout.",
    },
  },
  {
    id: "demo-scary-not-urgent",
    title: "Scary wording, completed charge",
    text: "URGENT — vehicle completely stopped in the driveway, customer panicked, said it would not go. Tech confirmed SOC 100%, charging session had ended normally, they just had not pressed start. No DTC. Cable was already unplugged. Please do not escalate as immobilization. One unit so far.",
    result: {
      subsystem: "Charging",
      subsystem_reason:
        "The actual event is a completed charging session and a misunderstanding of vehicle-ready state, not a crash or powertrain failure.",
      severity: "P3",
      severity_reason:
        "Despite 'completely stopped' language, evidence shows a normal charge-complete park with no DTC and a single vehicle — not P0 immobilization.",
      recovery_path: "Unknown",
      recovery_reason: "Nothing failed. The session ended normally; there is no recovery action.",
      trigger_condition: "End of charging session",
      trigger_reason: "The car was stationary because charging finished, not because it was disabled.",
      suggested_owner: "Diagnostics",
      owner_reason: "This is a misread of a completed charge; diagnostics/care should confirm logs before paging vehicle software.",
      issue_type: "Bug",
      affected_vehicle_count: 1,
      affected_vehicle_basis: "The report states \"One unit so far.\"",
      summary:
        "Not a stranded-vehicle event. Wording is alarming, but the evidence is a finished charge and a parked car. Do not escalate as P0.",
    },
  },
  {
    id: "demo-parked-charge",
    title: "Parked after charge (not P0)",
    text: "Vehicle completely stopped after charging, but the charging session had ended normally and the vehicle was intentionally parked.",
    result: {
      subsystem: "Charging",
      subsystem_reason: "The report is about a charging session that ended normally, not a drive-away immobilization.",
      severity: "P3",
      severity_reason: "\"Completely stopped\" is explained as an intentional park after a normal charge end — not loss of vehicle control.",
      recovery_path: "Unknown",
      recovery_reason: "No fault to recover; the session ended normally.",
      trigger_condition: "End of charging session",
      trigger_reason: "The report states the charging session had ended normally and the vehicle was intentionally parked.",
      suggested_owner: "Diagnostics",
      owner_reason: "Needs a careful read so scary wording does not page the wrong team.",
      issue_type: "Bug",
      affected_vehicle_count: null,
      affected_vehicle_basis: "",
      summary: "Not P0. The vehicle was parked after a completed charge. Do not escalate as immobilization.",
    },
  },
  {
    id: "demo-enhancement",
    title: "Enhancement: OTA progress",
    text: "Drivers are asking if we can add a percent complete that doesn't jump backwards. Fleet manager wants to see which ECU is installing. Would be useful if the app showed more than just 'updating'. Not a failed update.",
    result: {
      subsystem: "OTA Update",
      subsystem_reason: "The request is about campaign progress presentation, not a failed ECU.",
      severity: "P3",
      severity_reason: "This is an enhancement request with no failure, safety issue, or fleet outage described.",
      recovery_path: "Unknown",
      recovery_reason: "There is no incident to recover from.",
      trigger_condition: "Unclear",
      trigger_reason: "Not an incident — no failure trigger exists in the text.",
      suggested_owner: "Product Management",
      owner_reason: "Feature visibility for OTA belongs on the product backlog, not an incident queue.",
      issue_type: "Enhancement",
      affected_vehicle_count: null,
      affected_vehicle_basis: "",
      summary:
        "Product enhancement: clearer OTA progress. Keep it visible, do not treat it as a P1 campaign failure unless tied to actual stalls.",
    },
  },
  {
    id: "demo-fleet-stale",
    title: "Minor-sounding app lag, large fleet",
    text: "One vehicle occasionally shows stale status in the app. Looking at the fleet tool though we are seeing the same lag across hundreds of vans (we counted 640 this morning). SOC and location behind by 10–20 min. Vehicles are fine. Please do not close as single unit.",
    result: {
      subsystem: "Cloud Backend",
      subsystem_reason: "On-vehicle operation is fine; the stale SOC/location is a status pipeline / app-cloud problem.",
      severity: "P2",
      severity_reason:
        "Not safety-critical, but 640 vehicles with stale dispatch data is significant operational disruption — higher than a single glitch, not P0.",
      recovery_path: "OTA / Remote Recovery",
      recovery_reason: "No technician visit is required; freshness is a backend/app fix.",
      trigger_condition: "Cloud status pipeline lag",
      trigger_reason: "Dispatchers see delayed pins while the vans themselves are operating.",
      suggested_owner: "Cloud Platform",
      owner_reason: "Scale of stale telemetry points at ingest/cache, not a single head unit.",
      issue_type: "Bug",
      affected_vehicle_count: 640,
      affected_vehicle_basis: "The report states \"we counted 640 this morning\".",
      summary:
        "Looks like a small app issue. Evidence is hundreds of vans with stale status. Prioritize as a fleet-tooling reliability problem.",
    },
  },
];

export function matchDemoExample(text) {
  const n = normalize(text);
  let best = null;
  let bestScore = 0;
  for (const ex of DEMO_EXAMPLES) {
    const score = overlap(n, normalize(ex.text));
    if (score > bestScore) {
      bestScore = score;
      best = ex;
    }
  }
  if (best && bestScore >= 0.55) return best;
  return null;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function overlap(a, b) {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = new Set(a.split(" ").filter((w) => w.length > 3));
  const wb = new Set(b.split(" ").filter((w) => w.length > 3));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union ? inter / union : 0;
}
