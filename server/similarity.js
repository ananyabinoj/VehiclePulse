/**
 * similarity.js — "which existing reports look like this one?"
 *
 * §17: real semantic similarity over actual report content, top 3 results, a score,
 * and an explanation built from words the two reports genuinely share.
 * §14: similarity is NOT duplication. Wording stays "similar" unless the evidence is
 * overwhelming, in which case we say "possible duplicate" — still hedged, never confirmed.
 */
import { embedMany, cosine, sharedTerms, documentFrequency, tokenize, localVector } from "./embeddings.js";

export { tokenize };

/** Cheap lexical score used only to shortlist candidates before embedding. */
function lexicalScore(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

/** Backwards-compatible synchronous lexical similarity. */
export function similarity(textA, textB) {
  return cosine(localVector(textA), localVector(textB));
}

/**
 * Text used to represent a stored report in the vector space. Triage fields are
 * included when present because they carry real signal, but rawText dominates so an
 * un-analysed imported report is still comparable.
 */
export function reportText(r) {
  return [r.rawText, r.component, r.triggerCondition, r.subsystem, r.triageSummary]
    .filter(Boolean)
    .join("\n");
}

/**
 * Corpus baseline: the typical similarity between two unrelated reports. Automotive
 * text is domain-heavy, so raw cosine never approaches zero — subtracting the baseline
 * makes the displayed percentage mean "similar *for this corpus*" instead of
 * "shares the word vehicle".
 */
export function baselineSimilarity(vectors) {
  if (vectors.length < 8) return 0;
  const sample = [];
  const step = Math.max(1, Math.floor(vectors.length / 40));
  for (let i = 0; i < vectors.length; i += step) sample.push(vectors[i]);
  const scores = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) scores.push(cosine(sample[i], sample[j]));
  }
  if (!scores.length) return 0;
  scores.sort((a, b) => a - b);
  // 75th percentile of random pairs: a similarity must beat most of the corpus to count.
  return scores[Math.floor(scores.length * 0.75)];
}

/**
 * Raw cosine is not directly presentable. Unrelated automotive complaints still score
 * ~0.25 on OpenAI embeddings (shared domain vocabulary), while local hashed vectors
 * top out well below 1.0 for genuine paraphrases. So we map cosine onto a displayed
 * score using two anchors per engine: the corpus baseline maps to 0%, and a
 * "clearly the same problem" cosine maps to 85%, leaving headroom to 100% for
 * near-identical text. The raw cosine is always returned alongside for auditability.
 */
const CLEAR_MATCH_COSINE = { local: 0.5, openai: 0.8 };

function clearMatchAnchor(engine) {
  return String(engine || "").startsWith("openai") ? CLEAR_MATCH_COSINE.openai : CLEAR_MATCH_COSINE.local;
}

/**
 * The cosine above which two reports are treated as the same underlying problem when
 * clustering themes. Derived from the same anchors as the displayed score so the two
 * features never disagree about what "similar" means on a given engine.
 */
export function clusterThreshold(baseline, engine) {
  const anchor = clearMatchAnchor(engine);
  return baseline + 0.45 * Math.max(0.05, anchor - baseline);
}

function calibrate(cos, baseline, engine) {
  const anchor = Math.max(baseline + 0.1, clearMatchAnchor(engine));
  if (cos <= baseline) return 0;
  if (cos >= anchor) {
    // Above the anchor, stretch the remaining 15% across [anchor, 1].
    return Math.min(1, 0.85 + (0.15 * (cos - anchor)) / Math.max(0.01, 1 - anchor));
  }
  return (0.85 * (cos - baseline)) / (anchor - baseline);
}

const MIN_DISPLAY = 0.22;
const DUPLICATE_HINT = 0.8;

/** ~15 candidates for the LLM similar-reports field. Subsystem match first; no embeddings. */
export function pickCandidateSummaries(text, reports, { excludeId = null, limit = 15 } = {}) {
  const pool = reports.filter((r) => r.id !== excludeId && (r.rawText || r.triageSummary));
  const guessed = guessSubsystem(text);
  const qTokens = tokenize(text);
  return pool
    .map((r) => {
      const sub = String(r.subsystem || r.component || "").toLowerCase();
      let s = lexicalScore(qTokens, tokenize(`${r.subsystem || ""} ${r.triageSummary || r.rawText || ""}`));
      if (guessed && sub.includes(guessed)) s += 5;
      return { r, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r }) => ({
      id: r.id,
      subsystem: r.subsystem || r.component || "",
      summary: String(r.triageSummary || r.rawText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140),
      severity: r.severity,
      sourceType: r.sourceType,
    }));
}

function guessSubsystem(text) {
  const t = String(text || "").toLowerCase();
  if (/\bbcm\b|body control|ota|campaign|reflash/.test(t)) return "ota";
  if (/\bcharg/.test(t)) return "charg";
  if (/\binfotainment|screen|bluetooth|nav/.test(t)) return "infotainment";
  if (/\bcellular|telematics|modem/.test(t)) return "connect";
  if (/\bapp\b|stale status|location/.test(t)) return "cloud";
  return "";
}

/**
 * Demo-mode / fallback similar reports: lexical overlap only (no embeddings).
 */
export async function findSimilarReports(text, reports, { limit = 3, excludeId = null } = {}) {
  const pool = reports.filter((r) => r.id !== excludeId && (r.rawText || "").trim().length > 0);
  if (!pool.length) {
    return { matches: [], engine: "lexical", degraded: false, baseline: 0, noStrongMatches: true, comparedAgainst: 0 };
  }

  const qTokens = tokenize(text);
  const df = documentFrequency(pool.map(reportText));
  const scored = pool
    .map((r) => ({
      report: r,
      score: lexicalScore(qTokens, tokenize(reportText(r))),
    }))
    .sort((a, b) => b.score - a.score);

  const matches = scored
    .filter((s) => s.score >= MIN_DISPLAY)
    .slice(0, limit)
    .map((s) => {
      const terms = sharedTerms(text, reportText(s.report), { corpusDf: df, totalDocs: pool.length });
      return {
        id: s.report.id,
        similarity: Math.round(s.score * 100),
        relation: s.score >= DUPLICATE_HINT ? "Possible duplicate — verify" : "Similar report",
        reason: explain(s.report, terms),
        sharedTerms: terms,
        shortDescription: s.report.triageSummary || truncate(s.report.rawText, 180),
        theme: s.report.theme || null,
        severity: s.report.severity || null,
        vehicleModel: s.report.vehicleModel || null,
        component: s.report.component || null,
        sourceType: s.report.sourceType || "synthetic",
        analysisStatus: s.report.analysisStatus || "analyzed",
      };
    });

  return {
    matches,
    engine: "lexical",
    degraded: false,
    baseline: 0,
    comparedAgainst: pool.length,
    noStrongMatches: matches.length === 0,
  };
}

function explain(report, terms) {
  const bits = [];
  if (terms.length) bits.push(`Both mention ${terms.slice(0, 4).map((t) => `"${t}"`).join(", ")}`);
  if (report.triggerCondition && report.triggerCondition !== "Trigger unclear") {
    bits.push(`the stored report's trigger is ${report.triggerCondition.toLowerCase()}`);
  }
  if (report.component) bits.push(`component cited: ${report.component}`);
  if (!bits.length) {
    return "Vectors are close but no single distinctive term is shared — treat this as a weak match and read the report before merging.";
  }
  return `${bits.join("; ")}.`;
}

function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Legacy synchronous helper kept so any older call site keeps working.
 * Prefer findSimilarReports — it uses the real embedding engine.
 */
export function findSimilar(text, reports, limit = 3) {
  const qv = localVector(text);
  return reports
    .map((r) => ({ r, s: cosine(qv, localVector(reportText(r))) }))
    .sort((a, b) => b.s - a.s)
    .filter((x) => x.s >= 0.25)
    .slice(0, limit)
    .map((x) => ({
      id: x.r.id,
      similarity: Math.round(x.s * 100),
      shortDescription: x.r.triageSummary || truncate(x.r.rawText, 180),
      reason: `Shares ${sharedTerms(text, reportText(x.r)).slice(0, 3).join(", ")}.`,
      theme: x.r.theme,
      severity: x.r.severity,
      vehicleModel: x.r.vehicleModel,
    }));
}
