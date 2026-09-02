/**
 * themeNarratives.js — curated prose for themes that exist in the seed corpus.
 *
 * These are NOT hardcoded themes. Themes are always discovered by clustering the real
 * corpus (see themes.js). This file only supplies better-written description /
 * why-it-matters / product-improvement text when a discovered cluster turns out to match
 * a demo theme the seed data already carries.
 *
 * Anything discovered from imported data has no entry here and gets its narrative
 * generated from cluster evidence instead. If you delete this file's contents the product
 * still works — the prose is just blunter.
 */
export const CURATED_THEME_NARRATIVES = {
  "OTA Updates Failing After Vehicle Sleep": {
    description:
      "Multiple fleets report OTA campaigns failing or stalling after vehicles remain parked overnight.",
    whyItMatters:
      "Campaign 4.2.1 is consuming depot labour and fleets are already asking to pause the rollout. This is a product reliability issue, not a pile of unrelated tickets.",
    productImprovement:
      "Improve OTA campaign resilience after ECU sleep states and provide clearer rollout health monitoring so stalled BCM packages are visible before fleets ask to pause.",
  },
  "Infotainment Freeze After 4.2.0": {
    description:
      "Head-unit freeze after recent software, spanning a large Ridge fleet and a Helix regression set.",
    productImprovement:
      "Ship a head-unit stability fix for 4.2.x, add fleet-level freeze telemetry, and block similar regressions on Helix with a release-gate test.",
  },
  "Intermittent Cellular / Telematics Drops": {
    description:
      "Vans lose backend connectivity in weak-coverage regions and after deep sleep, then reconnect slowly.",
    productImprovement:
      "Harden modem re-attach after coverage loss and deep sleep, and expose reconnect-time metrics to fleet tools.",
  },
  "Stale Vehicle Status in Mobile App": {
    description:
      "App and fleet tools show delayed SOC/location even though the vehicles themselves are operating.",
    whyItMatters:
      "Each ticket sounds minor, but hundreds of vans with stale status change how dispatch runs. Volume × operational drag is the story.",
    productImprovement:
      "Fix cloud status freshness (cache TTL / ingest lag) and show 'last updated' clearly so dispatch does not treat stale pins as truth.",
  },
  "High-Volume Low-Severity Audio Hiss": {
    description: "A faint Bluetooth pause hiss generating a very large number of low-severity retail tickets.",
    whyItMatters:
      "Not urgent per vehicle, but the ticket volume will dominate care queues and NPS comments until it is scheduled as a polish fix.",
    productImprovement:
      "Schedule a DSP/EQ polish for Helix Bluetooth idle noise; treat it as a care-volume problem, not an incident war-room.",
  },
  "DC Charge Session Stops Unexpectedly": {
    description: "DC fast-charge sessions abort mid-session on Volt Hatch, sometimes needing a bay reset.",
    productImprovement:
      "Improve DC handshake robustness and publish a clearer fault reason to the driver and fleet tool when a session aborts.",
  },
  "Stale Charging Status After Unplug": {
    description: "Charging state remains 'charging' after the cable is removed.",
    productImprovement:
      "End cloud charging state when the onboard session ends; do not wait for a later ignition cycle.",
  },
  "Delayed Remote Lock Commands": {
    productImprovement:
      "Reduce remote-command queue latency and surface an honest 'sending…' state instead of a silent wait.",
  },
  "Gateway Faults After 4.2.1": {
    description: "Gateway communication and config issues after the 4.2.x software drop.",
    productImprovement:
      "Add post-OTA gateway dataset verification and a remote recovery path before requiring a workshop flash.",
  },
  "BCM Door-Lock Behavior After Update": {
    description: "Door-lock status and physical lock state disagree after the BCM package.",
    productImprovement:
      "Preserve lock configuration across BCM updates and add a status-consistency check between app and latch.",
  },
  "Lighting Configuration Resets": {
    productImprovement:
      "Persist customer lighting profiles across software updates instead of reverting to factory coding.",
  },
  "Bluetooth Drops After Phone Reconnect": {
    productImprovement:
      "Fix BT re-pairing after phones leave and re-enter range; avoid requiring forget-and-pair.",
  },
  "Stale Navigation Map Data": {
    productImprovement: "Make map tile refresh reliable after 4.2.0 and allow a remote map package push.",
  },
  "5.0.1-beta Version-Specific OTA Defect": {
    description: "Pilot 5.0.1-beta fails package verify; rollback to 4.2.1 recovers units.",
    productImprovement:
      "Halt 5.0.1-beta, fix package verify, and keep rollback as a documented remote recovery.",
  },
  "Enhancement: OTA Progress Visibility": {
    whyItMatters:
      "These are product asks, not defects. They should stay visible so they are not lost, without jumping the incident queue.",
    productImprovement: "Show ECU-level OTA progress and stuck-step identity in the app and fleet console.",
  },
  "Enhancement: Scheduled OTA Windows": {
    whyItMatters:
      "These are product asks, not defects. They should stay visible so they are not lost, without jumping the incident queue.",
    productImprovement: "Let fleets schedule and stagger campaign windows by depot timezone.",
  },
  "Enhancement: Fleet-Level Alerts": {
    whyItMatters:
      "These are product asks, not defects. They should stay visible so they are not lost, without jumping the incident queue.",
    productImprovement: "Page once when many vehicles share an OTA error, not once per VIN email.",
  },
  "Enhancement: Detailed Charging Status": {
    whyItMatters:
      "These are product asks, not defects. They should stay visible so they are not lost, without jumping the incident queue.",
    productImprovement: "Expose power, remaining time, and handshake fault text during charge sessions.",
  },
  "Isolated OTA Failures": {
    productImprovement:
      "Keep isolated dealer failures in a holding pattern until they match a campaign signature.",
  },
  "Infotainment Freeze (Isolated)": {
    productImprovement:
      "Do not merge one-off lab freezes into the fleet freeze programme without matching logs.",
  },
  "One-off Hardware Display Fault": {
    productImprovement: "Keep hardware water/cable failures out of software freeze metrics.",
  },
  "Harmless Charge-Complete Misread": {
    whyItMatters:
      "This cluster exists so scary wording is not auto-escalated. It is a training example for the triage rubric.",
    productImprovement:
      "Train intake to separate 'vehicle stationary after a completed charge' from immobilisation.",
  },
  "Incomplete / Unclear Field Reports": {
    whyItMatters:
      "Incomplete tickets waste engineering time if they are treated as facts. The action is evidence collection.",
    productImprovement:
      "Require VIN, model, software, and a minimum symptom template before engineering assignment.",
  },
  "ADAS Calibration — Volt Hatch Only": {
    productImprovement:
      "Publish the windshield-replacement calibration path for Volt Hatch; do not generalise to other models yet.",
  },
};
