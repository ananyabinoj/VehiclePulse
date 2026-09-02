/**
 * themes.js — finds the recurring problems hiding in the corpus.
 *
 * §19: themes are derived from the reports actually present, by clustering their
 * embeddings — not from a hardcoded list. Imported NHTSA reports carry no theme label,
 * so derivation is the only thing that can work on real data.
 *
 * §20/§21: Priority Score = affected vehicles × severity weight, an MVP heuristic.
 * Report count and vehicle count are tracked separately and an unknown vehicle count
 * stays unknown — it is never replaced with a guess (§17).
 */
import { SEVERITY_WEIGHTS, SEVERITIES, severityWeight, severityRank, UNCLEAR_TRIGGER } from "./rubric.js";
import { documentFrequency, cosine } from "./embeddings.js";
import { reportText } from "./similarity.js";
import { CURATED_THEME_NARRATIVES } from "./themeNarratives.js";
import { llmJson, DEFAULT_MODEL } from "./analyze.js";
import {
  corpusFingerprint,
  getThemeCache,
  setThemeCache,
  clearThemeCache,
  persist,
} from "./db.js";

/** A cluster needs at least this many reports before we call it "recurring". */
const RECURRING_MIN = 2;

/* ------------------------------------------------------------------ clustering */

/**
 * Greedy leader clustering with a centroid refinement pass.
 *
 * Seeds are visited most-severe-and-largest first so a serious recurring problem
 * anchors its own cluster instead of being absorbed into a chatty low-severity one.
 * Cheap (O(n·k)) and, unlike k-means, needs no guess at how many themes exist.
 *
 * Clustering is partitioned by subsystem. A theme asserts one recurring underlying
 * problem with one owner and one product recommendation, so a cluster spanning
 * Visibility and Engine is not a theme — it is a similarity artefact. Consumer
 * complaint prose is formulaic enough ("the contact stated that…") that vectors alone
 * will happily merge a sunroof leak with an engine stall; the triaged subsystem is a
 * far more reliable boundary than the wording, so it is enforced as a hard one.
 */
function clusterReports(reports, vectors, threshold) {
  const keyOf = (r) => (r.subsystem || "Unassigned").trim().toLowerCase();
  const order = reports
    .map((r, i) => ({ i, r }))
    .sort(
      (a, b) =>
        severityRank(a.r.severity) - severityRank(b.r.severity) ||
        (b.r.affectedVehicles || 0) - (a.r.affectedVehicles || 0)
    );

  let clusters = [];
  for (const { i, r } of order) {
    const key = keyOf(r);
    let best = null;
    let bestSim = threshold;
    for (const c of clusters) {
      if (c.key !== key) continue;
      const sim = cosine(vectors[i], c.centroid);
      if (sim >= bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best) {
      best.members.push(i);
      best.centroid = meanVector(best.members.map((m) => vectors[m]));
    } else {
      clusters.push({ key, members: [i], centroid: vectors[i] });
    }
  }

  // Refinement: with settled centroids, let each report move to its true best cluster
  // — within its own subsystem only, for the reason above.
  const centroids = clusters.map((c) => c.centroid);
  const keys = clusters.map((c) => c.key);
  const reassigned = centroids.map(() => []);
  for (let i = 0; i < reports.length; i++) {
    const key = keyOf(reports[i]);
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
      if (keys[c] !== key) continue;
      const sim = cosine(vectors[i], centroids[c]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = c;
      }
    }
    if (bestIdx >= 0) reassigned[bestIdx].push(i);
  }

  return reassigned.filter((m) => m.length > 0);
}

function meanVector(vecs) {
  if (!vecs.length) return new Float64Array(0);
  const out = new Float64Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/* ------------------------------------------------------------------- labelling */

const NAME_STOP = new Set(
  `vehicle vehicles report reports customer customers driver drivers unit units fleet
   said says told update updates issue issues problem problems service dealer
   complaint complaints time times day days week weeks month months
   contact contacted please would could should also been being have has had
   stated state states mileage miles mile approximately approx failure failures
   shop shops taken took drove driving drive driven purchased bought owns owned
   informed notified aware advised diagnosed repaired repair fixed
   apparently continually currently researching groceries additonal additional
   manufacturer local independent nearby unknown other
   however although though whether therefore meanwhile furthermore
   appears appear appeared seems seemed seem escalating escalate escalated
   properly correctly normally suddenly immediately subsequently eventually
   purchasing purchase purchases resulting caused causing
   occurred occurring occurs occur happened happening happens
   experienced experiencing experience noticed noticing notice
   began begin started starting attempted attempting attempt
   received receive receiving requested requesting request`.split(/\s+/)
);

/**
 * A cluster's head label. Component text arriving from NHTSA is upper-case and can name
 * several systems at once, which makes an unreadable theme title — take the first named
 * system, title-case it, and keep it short.
 */
function headLabel(raw) {
  let s = String(raw || "").split(";")[0].split(":")[0].trim();
  if (!s) return "Unclassified reports";
  if (s === s.toUpperCase()) {
    s = s
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w.length > 2 ? titleCase(w) : w))
      .join(" ");
  }
  return s.length > 44 ? `${s.slice(0, 42).trim()}…` : s;
}

/**
 * Terms that are common inside the cluster but rare outside it — what makes it distinct.
 *
 * `banned` carries the makes and models of the cluster's own members. "Chevrolet" is
 * highly distinctive and completely useless as the name of a problem, and the same is
 * true of adverbs ("thankfully", "initially"), so both are excluded. In a cluster of two
 * or more, a term must appear in at least two members: a theme name should describe
 * something that actually recurs, not a stray word from one complaint.
 */
function distinctiveTerms(memberTexts, corpusDf, corpusSize, limit = 3, banned = new Set()) {
  const clusterDf = documentFrequency(memberTexts);
  const n = memberTexts.length;
  const minDf = n >= 2 ? 2 : 1;
  const scored = [];
  for (const [term, df] of clusterDf) {
    if (NAME_STOP.has(term) || banned.has(term) || term.length < 3 || /^\d+$/.test(term)) continue;
    if (term.length > 5 && term.endsWith("ly")) continue; // adverbs describe nobody's defect
    if (df < minDf) continue;
    const inCluster = df / n;
    if (inCluster < 0.4) continue; // must be characteristic of the cluster, not incidental
    const outside = ((corpusDf.get(term) || df) - df) / Math.max(1, corpusSize - n);
    const lift = (inCluster + 0.05) / (outside + 0.05);
    if (lift < 1.3) continue; // present everywhere → says nothing about this cluster
    scored.push({ term, score: lift * (0.7 + Math.min(0.6, term.length / 14)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.term);
}

/** Make/model words from a cluster's own members — distinctive, but never a problem name. */
function vehicleWords(members) {
  const out = new Set();
  for (const r of members) {
    for (const field of [r.make, r.vehicleModel, r.model]) {
      for (const w of String(field || "").toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length >= 3) out.add(w);
      }
    }
  }
  return out;
}

/** Shortens a trigger into something that reads inside a theme name. */
function triggerPhrase(trigger) {
  const t = String(trigger || "").toLowerCase().replace(/\.$/, "");
  if (/overnight|sat unused|sitting unused|cold soak/.test(t)) return "overnight parking";
  if (/sleep/.test(t)) return "vehicle sleep";
  if (/connectivity|coverage|cellular|signal/.test(t)) return "weak connectivity";
  if (/charg/.test(t)) return "charging sessions";
  if (/version|campaign|software/.test(t)) return t.replace(/^(a|the)\s+/, "");
  if (/ignition/.test(t)) return "ignition cycles";
  if (/temperature|cold|heat/.test(t)) return "temperature extremes";
  return t.length > 42 ? `${t.slice(0, 40)}…` : t;
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Names a cluster from its own contents. Falls back through: the curated corpus label
 * (when the seed reports agree on one), then subsystem + distinctive terms + trigger,
 * then the component as filed. `nameBasis` records which, so the name is explainable.
 */
function nameCluster(members, terms, dominantTrigger) {
  const labels = tally(members.map((r) => r.theme).filter(Boolean));
  if (labels.length && labels[0].count / members.length >= 0.6) {
    return {
      name: labels[0].label,
      nameSource: "corpus-label",
      nameBasis: `${labels[0].count} of ${members.length} reports in this cluster already carry the label "${labels[0].label}".`,
    };
  }

  const subsystems = tally(members.map((r) => r.subsystem).filter(Boolean));
  const head = headLabel(
    subsystems[0]?.label || tally(members.map((r) => r.component).filter(Boolean))[0]?.label
  );
  const trigPhrase = dominantTrigger ? triggerPhrase(dominantTrigger) : "";

  // Drop terms already implied by the subsystem or the trigger, so the name does not
  // read "Charging — unplugged / end after charging sessions".
  const context = `${head} ${trigPhrase}`.toLowerCase();
  const useful = terms.filter((t) => t.length > 3 && !context.includes(t) && !t.includes(head.toLowerCase()));

  const termPart = useful.slice(0, 2).join(" / ");
  const trigPart = trigPhrase ? ` after ${trigPhrase}` : "";

  const name = termPart ? `${titleCase(head)} — ${termPart}${trigPart}` : `${titleCase(head)}${trigPart}`;
  const basisBits = [];
  if (subsystems[0]) basisBits.push(`${subsystems[0].count} of ${members.length} reports point at ${subsystems[0].label}`);
  if (useful.length) basisBits.push(`the terms ${useful.slice(0, 2).map((t) => `"${t}"`).join(" and ")} recur across the cluster`);
  if (dominantTrigger) basisBits.push(`most share the trigger "${dominantTrigger}"`);

  return {
    name,
    nameSource: "derived",
    nameBasis: basisBits.length
      ? `${titleCase(basisBits.join("; "))}.`
      : "Grouped by text similarity; no single term or subsystem dominates.",
  };
}

function tally(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

function countField(items, field, { skipEmpty = false } = {}) {
  const m = new Map();
  for (const r of items) {
    const k = r[field];
    if (skipEmpty && !k) continue;
    m.set(k || "Unknown", (m.get(k || "Unknown") || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

/* ------------------------------------------------------- narrative generation */

/** "What keeps happening" — assembled from cluster evidence, never invented. */
function whatWereSeeing(members, terms, triggers, recoveries) {
  const out = [];
  const analyzed = members.filter((r) => r.analysisStatus === "analyzed");

  if (terms.length) {
    out.push(`Recurring language across these reports: ${terms.map((t) => `"${t}"`).join(", ")}.`);
  }
  const topTrig = triggers.find((t) => t.label !== UNCLEAR_TRIGGER && t.label !== "Unknown");
  if (topTrig) {
    out.push(`${topTrig.count} of ${members.length} reports share the trigger "${topTrig.label}".`);
  } else if (members.length > 1) {
    out.push(`No reproducible trigger is established yet across these ${members.length} reports.`);
  }

  const service = recoveries.find((r) => r.label === "Service Visit");
  const remote = recoveries.find((r) => r.label === "OTA / Remote Recovery");
  if (service && (!remote || service.count >= remote.count)) {
    out.push(`${service.count} needed a service visit, so remote recovery does not currently look sufficient.`);
  } else if (remote) {
    out.push(`${remote.count} were recovered remotely, which suggests a fix can ship without depot visits.`);
  }

  const models = tally(members.map((r) => r.vehicleModel || r.make).filter(Boolean));
  if (models.length > 1) {
    out.push(`Spans ${models.length} vehicle models (${models.slice(0, 3).map((m) => m.label).join(", ")}), so this is unlikely to be one bad batch.`);
  } else if (models.length === 1) {
    out.push(`All reports are on ${models[0].label}, so a model-specific cause is possible.`);
  }

  const pending = members.length - analyzed.length;
  if (pending > 0) out.push(`${pending} report${pending === 1 ? "" : "s"} in this cluster are not yet triaged.`);

  return out;
}

/**
 * §24 — turn the technical pattern into a product-level recommendation. Built from the
 * cluster's dominant subsystem, trigger and recovery mix so it names a change to make,
 * rather than restating the symptom.
 */
function productImprovement({ name, members, subsystem, dominantTrigger, recoveries, issueTypes, terms }) {
  const curated = CURATED_THEME_NARRATIVES[name];
  if (curated?.productImprovement) return curated.productImprovement;

  // Nothing in this cluster has been triaged, so there is no evidence base for a
  // product recommendation yet. Saying so beats inventing one (§17).
  const analyzed = members.filter((r) => r.analysisStatus === "analyzed" && r.severity);
  if (!analyzed.length) {
    const scope = terms.length ? ` The reports repeatedly mention ${terms.slice(0, 2).map((t) => `"${t}"`).join(" and ")}.` : "";
    return `Triage these ${members.length} report${members.length === 1 ? "" : "s"} before drawing a product conclusion — severity, recovery path and trigger are all still unknown for this cluster, so any recommendation would be guesswork.${scope}`;
  }

  const enhancement = issueTypes.find((i) => i.label === "Enhancement");
  if (enhancement && enhancement.count / analyzed.length >= 0.6) {
    return `Treat this as a product backlog item rather than an incident: ${members.length} reports are asking for capability that does not exist yet. Scope it, give it an owner, and tell the requesting fleets where it sits so the asks stop arriving as tickets.`;
  }

  const service = recoveries.find((r) => r.label === "Service Visit");
  const needsDepot = service && service.count / members.length >= 0.4;
  const trig = dominantTrigger ? triggerPhrase(dominantTrigger) : null;
  const area = subsystem ? headLabel(subsystem) : null;
  const detail = terms.length ? ` around ${terms.slice(0, 2).join(" / ")}` : "";

  const parts = [];
  if (needsDepot) {
    parts.push(
      `Add a remote recovery path${area ? ` for ${area}` : ""}${detail} so this stops consuming depot labour — today ${service.count} of ${members.length} reports needed a technician.`
    );
  } else {
    parts.push(
      `Fix the underlying ${area ? `${area} ` : ""}defect${detail} and ship it as one change rather than closing ${members.length} report${members.length === 1 ? "" : "s"} separately.`
    );
  }
  if (trig) {
    parts.push(`Add a regression test and fleet monitoring for ${trig}, since that is the condition these reports keep sharing.`);
  } else {
    parts.push(`Instrument this path so the reproducible condition can be identified — the trigger is still unknown across these reports.`);
  }
  return parts.join(" ");
}

function whyItMatters({ name, members, severity, vehicles, vehiclesUnknown, recurring }) {
  const curated = CURATED_THEME_NARRATIVES[name];
  if (curated?.whyItMatters) return curated.whyItMatters;

  const scale =
    vehicles === null
      ? `Vehicle impact is not stated in any of these ${members.length} reports, so scale is unknown`
      : vehiclesUnknown > 0
        ? `At least ${vehicles.toLocaleString()} vehicles are implicated, with ${vehiclesUnknown} report${vehiclesUnknown === 1 ? "" : "s"} not stating a count`
        : `${vehicles.toLocaleString()} vehicles are implicated across ${members.length} reports`;

  if (!recurring) {
    return `${scale}. This is currently a single report — keep it visible, but it is not yet evidence of a systemic product problem.`;
  }
  return `${scale}. The same problem appearing ${members.length} times is the signal here: it is a product issue to fix once, not ${members.length} tickets to close individually. Peak severity in the cluster is ${severity || "not yet assessed"}.`;
}

function describe({ name, members, subsystem, dominantTrigger }) {
  const curated = CURATED_THEME_NARRATIVES[name];
  if (curated?.description) return curated.description;
  const trig = dominantTrigger ? ` The reports tie it to ${triggerPhrase(dominantTrigger)}.` : "";
  const area = subsystem ? headLabel(subsystem) : "an area that is not yet classified";
  return `${members.length} report${members.length === 1 ? "" : "s"} describing the same problem in ${area}.${trig}`;
}

/* ------------------------------------------------------------------ the export */

function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "theme"
  );
}

/**
 * Builds themes from the corpus. Async because it embeds the reports.
 * Returns { themes, untriaged, engine, degraded, threshold, baseline }.
 *
 * Only TRIAGED reports are clustered. A theme claims a severity, a priority score and a
 * product recommendation — none of which exist for a report that has not been analysed
 * yet, so clustering untriaged imports would either invent those values (§17) or bury the
 * real themes under hundreds of scoreless rows. Untriaged reports are therefore reported
 * as an explicit, countable population with a call to action, and they join the themes as
 * soon as they are analysed.
 */
export function invalidateThemeCache() {
  clearThemeCache();
  persist(true);
}

function seedThemeGroups(pool) {
  const m = new Map();
  for (const r of pool) {
    const name = r.theme || r.subsystem || "Ungrouped";
    if (!m.has(name)) m.set(name, []);
    m.get(name).push(r.id);
  }
  return [...m.entries()].map(([name, reportIds]) => ({ name, reportIds }));
}

async function llmThemeGroups(pool, apiKey) {
  const lines = pool.map(
    (r) =>
      `${r.id} | ${r.subsystem || "?"} | ${String(r.triageSummary || r.rawText || "")
        .replace(/\s+/g, " ")
        .slice(0, 120)}`
  );
  const raw = await llmJson(
    [
      {
        role: "system",
        content:
          "Group these automotive support reports into recurring themes. Return JSON {themes:[{name, report_ids:[]}]}. Each report id must appear in exactly one theme. Names should describe the product problem, not a generic word like issues.",
      },
      { role: "user", content: lines.join("\n") },
    ],
    apiKey,
    DEFAULT_MODEL
  );
  const themes = Array.isArray(raw.themes) ? raw.themes : [];
  const groups = themes
    .map((t) => ({
      name: String(t.name || "Untitled").slice(0, 80),
      reportIds: (t.report_ids || t.reportIds || []).map(String),
    }))
    .filter((g) => g.reportIds.length);
  return groups.length ? groups : seedThemeGroups(pool);
}

export async function buildThemes(reports, { apiKey } = {}) {
  const withText = reports.filter((r) => (r.rawText || "").trim().length > 0);
  const pool = withText.filter((r) => r.analysisStatus === "analyzed" && r.severity);
  const untriagedReports = withText.filter((r) => !(r.analysisStatus === "analyzed" && r.severity));
  const untriaged = summarizeUntriaged(untriagedReports);

  if (!pool.length) {
    return { themes: [], untriaged, engine: null, cached: false, error: null };
  }

  const fp = corpusFingerprint(pool);
  let groups;
  let engine = "labels";
  let cached = false;
  let error = null;
  const hit = getThemeCache(fp);
  if (hit?.groups) {
    groups = hit.groups;
    engine = hit.engine || "labels";
    cached = true;
  } else if (apiKey) {
    try {
      groups = await llmThemeGroups(pool, apiKey);
      engine = "llm";
      setThemeCache(fp, { groups, engine });
      persist(true);
    } catch (e) {
      error = String(e.message || e);
      groups = seedThemeGroups(pool);
      engine = "labels";
    }
  } else {
    groups = seedThemeGroups(pool);
    engine = "labels";
    setThemeCache(fp, { groups, engine });
    persist(true);
  }

  const byId = new Map(pool.map((r, i) => [r.id, i]));
  const clusterIdx = groups
    .map((g) => (g.reportIds || []).map((id) => byId.get(id)).filter((i) => i !== undefined))
    .filter((m) => m.length);
  const used = new Set(clusterIdx.flat());
  for (let i = 0; i < pool.length; i++) {
    if (!used.has(i)) clusterIdx.push([i]);
  }

  const nameTexts = pool.map((r) => [r.rawText, r.component].filter(Boolean).join("\n"));
  const corpusDf = documentFrequency(nameTexts);

  const named = clusterIdx.map((memberIdx) => {
    const members = memberIdx.map((i) => pool[i]);
    const analyzed = members.filter((r) => r.analysisStatus === "analyzed" && r.severity);
    const terms = distinctiveTerms(memberIdx.map((i) => nameTexts[i]), corpusDf, pool.length, 3, vehicleWords(members));
    const triggers = countField(analyzed, "triggerCondition");
    const top = triggers.find((t) => t.label !== UNCLEAR_TRIGGER && t.label !== "Unknown");
    const dominantTrigger = top && top.count / Math.max(1, analyzed.length) >= 0.4 ? top.label : null;
    return { memberIdx, ...nameCluster(members, terms, dominantTrigger) };
  });

  /**
   * Phase 2 — merge clusters that resolved to the same name.
   *
   * Two clusters carrying the same name ARE the same theme; showing them as separate
   * rows with separate scores would split the evidence and mislead the reviewer. This
   * also recovers reports that the vector threshold split off from their own group.
   */
  const merged = new Map();
  for (const g of named) {
    const existing = merged.get(g.name);
    if (existing) {
      existing.memberIdx.push(...g.memberIdx);
      existing.mergedClusters += 1;
    } else {
      merged.set(g.name, { ...g, memberIdx: [...g.memberIdx], mergedClusters: 1 });
    }
  }

  // Phase 3 — compute every aggregate from the final membership.
  const usedIds = new Set();
  const themes = [...merged.values()].map((group) => {
    const members = group.memberIdx.map((i) => pool[i]);
    const memberTexts = group.memberIdx.map((i) => nameTexts[i]);
    const analyzed = members.filter((r) => r.analysisStatus === "analyzed" && r.severity);

    // ---- Severity: only from reports that have actually been triaged.
    const dist = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const r of analyzed) if (dist[r.severity] !== undefined) dist[r.severity]++;
    const severity = SEVERITIES.find((s) => dist[s] > 0) || null;

    // ---- Vehicles: sum only the counts we actually know (§17/§21).
    const known = members.filter((r) => r.affectedVehicles !== null && r.affectedVehicles !== undefined);
    const vehiclesUnknown = members.length - known.length;
    const affectedVehicles = known.length ? known.reduce((s, r) => s + Number(r.affectedVehicles), 0) : null;

    // ---- Priority: the §20 heuristic, with an explicit fallback when scale is unknown.
    const weight = severity ? severityWeight(severity) : null;
    let priorityScore = null;
    let priorityBasis;
    if (affectedVehicles !== null && weight !== null) {
      priorityScore = Math.round(affectedVehicles * weight);
      priorityBasis = `${affectedVehicles.toLocaleString()} known affected vehicles × ${weight} (${severity} weight)${
        vehiclesUnknown > 0
          ? `. ${vehiclesUnknown} report${vehiclesUnknown === 1 ? "" : "s"} state no vehicle count and are excluded from the multiplication.`
          : "."
      }`;
    } else if (weight !== null) {
      // Transparent fallback: rank by report volume when no vehicle count exists at all.
      priorityScore = Math.round(members.length * weight);
      priorityBasis = `Affected vehicles unknown for every report in this cluster, so this falls back to ${members.length} report${
        members.length === 1 ? "" : "s"
      } × ${weight} (${severity} weight). Not comparable with vehicle-based scores.`;
    } else {
      priorityBasis = "Not yet triaged, so no severity weight exists and no priority score is claimed.";
    }

    const terms = distinctiveTerms(memberTexts, corpusDf, pool.length, 3, vehicleWords(members));
    const triggers = countField(analyzed, "triggerCondition");
    const recoveries = countField(analyzed, "recoveryPath");
    const issueTypes = countField(analyzed, "issueType", { skipEmpty: true });
    const topTrigger = triggers.find((t) => t.label !== UNCLEAR_TRIGGER && t.label !== "Unknown");
    const dominantTrigger =
      topTrigger && topTrigger.count / Math.max(1, analyzed.length) >= 0.4 ? topTrigger.label : null;

    const name = group.name;
    const subsystem = tally(members.map((r) => r.subsystem).filter(Boolean))[0]?.label || null;
    const recurring = members.length >= RECURRING_MIN;

    let id = slug(name);
    if (usedIds.has(id)) id = `${id}-${slug(members[0].id)}`;
    usedIds.add(id);

    return {
      id,
      name,
      nameSource: group.nameSource,
      nameBasis: group.nameBasis,
      mergedClusters: group.mergedClusters,
      description: describe({ name, members, subsystem, dominantTrigger }),
      severity,
      severityDistribution: dist,
      reportCount: members.length,
      analyzedCount: analyzed.length,
      untriagedCount: members.length - analyzed.length,
      recurring,
      affectedVehicles,
      affectedVehiclesKnownReports: known.length,
      affectedVehiclesUnknownReports: vehiclesUnknown,
      priorityScore,
      priorityBasis,
      priorityIsVehicleBased: affectedVehicles !== null && weight !== null,
      commonTriggers: triggers,
      commonRecovery: recoveries,
      issueTypes,
      subsystems: tally(members.map((r) => r.subsystem).filter(Boolean)).map((s) => s.label),
      models: [...new Set(members.map((r) => r.vehicleModel).filter(Boolean))],
      versions: [...new Set(members.map((r) => r.softwareVersion).filter(Boolean))],
      owners: [...new Set(members.map((r) => r.suggestedOwner).filter(Boolean))],
      sourceMix: countField(members, "sourceType"),
      distinctiveTerms: terms,
      reportIds: members.map((r) => r.id),
      reports: members,
      seeing: whatWereSeeing(members, terms, triggers, recoveries),
      whyItMatters: whyItMatters({ name, members, severity, vehicles: affectedVehicles, vehiclesUnknown, recurring }),
      productImprovement: productImprovement({
        name,
        members,
        subsystem,
        dominantTrigger,
        recoveries,
        issueTypes,
        terms,
      }),
    };
  });

  /**
   * Ranked by the §20 priority score. Vehicle-based scores rank above report-count
   * fallbacks because the two are not measured in the same unit — mixing them would
   * imply a comparison the data does not support.
   */
  themes.sort(
    (a, b) =>
      Number(b.priorityIsVehicleBased) - Number(a.priorityIsVehicleBased) ||
      (b.priorityScore ?? -1) - (a.priorityScore ?? -1) ||
      b.reportCount - a.reportCount
  );

  return {
    themes,
    untriaged,
    engine,
    cached,
    error,
  };
}

/**
 * The population held back from theming, described honestly. No severity, no score and
 * no product recommendation is claimed for these — only what they are and what to do next.
 */
function summarizeUntriaged(reports) {
  if (!reports.length) {
    return { count: 0, failed: 0, reportIds: [], components: [], sourceMix: [], note: null };
  }
  const failed = reports.filter((r) => r.analysisStatus === "failed").length;
  const components = tally(
    reports.map((r) => (r.component ? headLabel(r.component) : null)).filter(Boolean)
  ).slice(0, 6);
  return {
    count: reports.length,
    failed,
    reportIds: reports.map((r) => r.id),
    components,
    sourceMix: countField(reports, "sourceType"),
    note:
      `${reports.length.toLocaleString()} report${reports.length === 1 ? " is" : "s are"} not yet triaged, so ` +
      `${reports.length === 1 ? "it is" : "they are"} excluded from themes — a theme needs a severity and a trigger to mean anything. ` +
      `Run analysis to include ${reports.length === 1 ? "it" : "them"}.`,
    failedNote: failed
      ? `${failed} of these previously failed analysis and were left flagged rather than given guessed values.`
      : null,
  };
}

export function dashboardStats(reports, themes) {
  const known = reports.filter((r) => r.affectedVehicles !== null && r.affectedVehicles !== undefined);
  const untriaged = reports.filter((r) => !(r.analysisStatus === "analyzed" && r.severity));
  const themedReports = themes.reduce((s, t) => s + t.reportCount, 0);
  return {
    totalReports: reports.length,
    // Reports actually represented in the theme list — never silently equal to totalReports.
    themedReports,
    // Sum of stated counts only. The unknown tail is reported separately, not zero-filled.
    vehiclesAffected: known.reduce((s, r) => s + Number(r.affectedVehicles), 0),
    vehiclesAffectedKnownReports: known.length,
    vehiclesUnknownReports: reports.length - known.length,
    highCritical: reports.filter((r) => r.severity === "P0" || r.severity === "P1").length,
    recurringThemes: themes.filter((t) => t.recurring).length,
    totalThemes: themes.length,
    untriaged: untriaged.length,
    failedAnalysis: reports.filter((r) => r.analysisStatus === "failed").length,
  };
}

export { SEVERITY_WEIGHTS };
