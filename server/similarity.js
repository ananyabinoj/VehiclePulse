const STOP = new Set(
  `a an the of to and or for on in at by with from as is are was were be been being this that those these it its they them their we our you your not no nor if then than so such just only also into over after before about into across during without within than can could should would may might will shall do did does done have has had having unit units van vans vehicle vehicles car cars customer customers tech technician technicians report reports issue issues`.split(
    /\s+/
  )
);

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function tfMap(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) || 0;
    const y = b.get(k) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

const PHRASE_BONUS = [
  ["overnight", "parked", "sleep", "cold soak", "cold-soak"],
  ["bcm", "body control", "body controller"],
  ["ota", "campaign", "reflash", "4.2.1"],
  ["cellular", "telematics", "modem", "coverage"],
  ["freeze", "screen", "infotainment", "head unit"],
  ["charg", "handshake", "unplug", "soc"],
  ["stale", "location", "status", "app"],
  ["gateway", "u-code", "bus"],
  ["bluetooth", "bt", "pair"],
  ["hiss", "audio", "eq"],
];

function phraseScore(a, b) {
  const ta = a.toLowerCase();
  const tb = b.toLowerCase();
  let hits = 0;
  for (const group of PHRASE_BONUS) {
    const inA = group.some((g) => ta.includes(g));
    const inB = group.some((g) => tb.includes(g));
    if (inA && inB) hits++;
  }
  return Math.min(0.25, hits * 0.05);
}

export function similarity(textA, textB) {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  const cos = cosine(tfMap(ta), tfMap(tb));
  const jac = jaccard(ta, tb);
  return Math.min(1, cos * 0.55 + jac * 0.3 + phraseScore(textA, textB));
}

export function whySimilar(textA, report) {
  const shared = [];
  const hay = `${report.rawText} ${report.theme} ${report.triggerCondition}`.toLowerCase();
  const needle = textA.toLowerCase();
  const clues = [
    ["overnight parking / sleep", ["overnight", "parked", "sleep", "cold soak"]],
    ["BCM / body controller update step", ["bcm", "body control", "body controller"]],
    ["OTA campaign language", ["campaign", "ota", "4.2.1", "reflash"]],
    ["cellular / telematics loss", ["cellular", "telematics", "modem", "coverage"]],
    ["infotainment freeze", ["freeze", "screen", "hu"]],
    ["charging session", ["charg", "handshake", "unplug"]],
    ["stale app/status", ["stale", "app", "location", "status"]],
    ["gateway / bus", ["gateway"]],
    ["bluetooth", ["bluetooth"]],
  ];
  for (const [label, keys] of clues) {
    if (keys.some((k) => needle.includes(k) && hay.includes(k))) shared.push(label);
  }
  if (!shared.length) {
    return "Overlapping wording and tokens with this field report, not just a shared generic word like failure.";
  }
  return `Both describe ${shared.slice(0, 3).join("; ")}.`;
}

const STRONG_THRESHOLD = 0.22;

export function findSimilar(text, reports, limit = 3) {
  const scored = reports
    .map((r) => {
      const score = similarity(text, `${r.rawText} ${r.theme} ${r.triageSummary} ${r.triggerCondition}`);
      return { report: r, score };
    })
    .sort((a, b) => b.score - a.score);

  const strong = scored.filter((s) => s.score >= STRONG_THRESHOLD).slice(0, limit);
  return strong.map((s) => ({
    id: s.report.id,
    shortDescription: s.report.triageSummary,
    similarity: Math.round(s.score * 100),
    reason: whySimilar(text, s.report),
    theme: s.report.theme,
    severity: s.report.severity,
    vehicleModel: s.report.vehicleModel,
  }));
}
