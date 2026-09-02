/**
 * embeddings.js — semantic vectors for similarity search and theme clustering.
 *
 * Two engines, one interface:
 *   openai:text-embedding-3-small  when OPENAI_API_KEY is set (real semantics)
 *   local:v1-512                   deterministic hashed n-gram vectors, no network
 *
 * Vectors from different engines live in different spaces, so a whole batch is always
 * embedded with ONE engine. If the OpenAI call fails mid-batch we restart the entire
 * batch locally rather than silently comparing incompatible vectors.
 *
 * Everything is cached in SQLite keyed by (content hash, engine), so re-analysing or
 * rebuilding themes costs nothing after the first pass.
 */
import { getEmbeddings, putEmbeddings, hashText } from "./db.js";

export const OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const LOCAL_ENGINE = "local:v1-512";
const LOCAL_DIM = 512;
const OPENAI_BATCH = 96;
const MAX_CHARS = 6000;

export function embeddingEngine() {
  const openaiKey = process.env.OPENAI_API_KEY;
  return openaiKey
    ? { id: `openai:${OPENAI_EMBED_MODEL}`, label: "OpenAI text-embedding-3-small", semantic: true }
    : { id: LOCAL_ENGINE, label: "Local lexical vectors (Groq has no embeddings API)", semantic: false };
}

/* -------------------------------------------------------------- local vectors */

const STOP = new Set(
  `a an the of to and or for on in at by with from as is are was were be been being am this that those these it its they them their there then than so such just only also into over under after before about across during without within can could should would may might will shall do did does done have has had having i we you he she my our your not no nor if but too very s t don now other some what which who whom how when where why all any both each few more most much nor own same too if because while`.split(
    /\s+/
  )
);

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text) {
  return normalizeText(text)
    .split(" ")
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** FNV-1a — small, fast, stable across runs so cached vectors stay valid. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Signed feature hashing: one hash gives both the bucket and the sign. */
function addFeature(vec, key, weight) {
  const h = fnv1a(key);
  const idx = h % LOCAL_DIM;
  const sign = (h >>> 31) & 1 ? -1 : 1;
  vec[idx] += sign * weight;
}

/**
 * Deterministic local vector combining word unigrams, word bigrams and character
 * 4-grams. The char-grams are what let "won't take the update" land near
 * "update fails to install" without an embedding API.
 */
export function localVector(text) {
  const vec = new Float64Array(LOCAL_DIM);
  const tokens = tokenize(text);
  if (!tokens.length) return vec;

  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) addFeature(vec, `w:${t}`, 1 + Math.log(n));

  for (let i = 0; i < tokens.length - 1; i++) {
    addFeature(vec, `b:${tokens[i]}_${tokens[i + 1]}`, 0.7);
  }

  const flat = tokens.join(" ");
  for (let i = 0; i + 4 <= flat.length; i += 2) {
    addFeature(vec, `c:${flat.slice(i, i + 4)}`, 0.35);
  }

  let norm = 0;
  for (let i = 0; i < LOCAL_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < LOCAL_DIM; i++) vec[i] /= norm;
  return vec;
}

/* ------------------------------------------------------------- openai vectors */

async function openaiEmbedBatch(texts, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts.map((t) => String(t || "").slice(0, MAX_CHARS) || " ") }),
  });
  if (!res.ok) {
    throw new Error(`Embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => {
      const v = Float64Array.from(d.embedding);
      let n = 0;
      for (let i = 0; i < v.length; i++) n += v[i] * v[i];
      n = Math.sqrt(n);
      if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    });
}

/* ------------------------------------------------------------------ public API */

/**
 * Embeds many texts with a single engine. Returns { vectors, engine, degraded, error }.
 * `vectors` is index-aligned with `texts`.
 */
export async function embedMany(texts) {
  if (!texts.length) return { vectors: [], engine: embeddingEngine().id, degraded: false };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      return { ...(await embedWith(texts, `openai:${OPENAI_EMBED_MODEL}`, openaiKey)), degraded: false };
    } catch (e) {
      const local = await embedWith(texts, LOCAL_ENGINE, null);
      return { ...local, degraded: true, error: String(e.message || e) };
    }
  }
  return { ...(await embedWith(texts, LOCAL_ENGINE, null)), degraded: false };
}

async function embedWith(texts, engineId, apiKey) {
  const hashes = texts.map((t) => hashText(String(t || "").slice(0, MAX_CHARS)));
  const cached = getEmbeddings([...new Set(hashes)], engineId);

  const missingIdx = [];
  const seen = new Set();
  hashes.forEach((h, i) => {
    if (!cached.has(h) && !seen.has(h)) {
      seen.add(h);
      missingIdx.push(i);
    }
  });

  const fresh = [];
  if (missingIdx.length) {
    if (engineId === LOCAL_ENGINE) {
      for (const i of missingIdx) {
        const vec = localVector(texts[i]);
        cached.set(hashes[i], vec);
        fresh.push({ hash: hashes[i], vec });
      }
    } else {
      for (let s = 0; s < missingIdx.length; s += OPENAI_BATCH) {
        const slice = missingIdx.slice(s, s + OPENAI_BATCH);
        const vecs = await openaiEmbedBatch(
          slice.map((i) => texts[i]),
          apiKey,
          OPENAI_EMBED_MODEL
        );
        slice.forEach((i, k) => {
          cached.set(hashes[i], vecs[k]);
          fresh.push({ hash: hashes[i], vec: vecs[k] });
        });
      }
    }
    if (fresh.length) putEmbeddings(fresh, engineId);
  }

  const dim = engineId === LOCAL_ENGINE ? LOCAL_DIM : 1536;
  return {
    vectors: hashes.map((h) => cached.get(h) || new Float64Array(dim)),
    engine: engineId,
  };
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // Vectors are stored L2-normalized, so the dot product IS the cosine.
  return Math.max(-1, Math.min(1, dot));
}

/**
 * Narrative filler that is meaningless as evidence. Kept separate from STOP because it
 * is applied ONLY when explaining a match — changing the tokenizer would invalidate
 * every cached vector, and the vectors themselves rank correctly as they are.
 *
 * IDF alone is not enough here: a prose word like "whether" may be rare in the corpus
 * and so score highly, yet citing it as the reason two reports match is useless.
 */
const LOW_SIGNAL = new Set(
  `whether around month months week weeks day days time times thing things something anything
   says said say saying asking asked ask asks tell told telling get got getting give given
   take taken make made makes went going goes come came back again still yet even ever
   never always usually sometimes often really quite rather much more less
   one two three four five six seven eight nine ten several few couple
   ones first second third fourth fifth another other others same
   first-time second-time onto also
   please thanks thank note noted fyi update-note comment comments
   seems seem seemed looks look looked appears appear appeared
   able unable need needs needed want wants wanted
   report reports reported reporting case cases ticket tickets
   customer customers user users owner owners driver drivers
   issue issues problem problems thing another other others same
   morning evening night today yesterday tomorrow
   stated state states states stating mileage miles mile approximately approx
   contact contacts contacted owns owned purchased bought drove driving driven
   taken took brought informed notified aware advised
   apparently continually currently researching manufacturer dealer dealership
   local independent nearby anywhere somewhere
   however although though therefore meanwhile furthermore
   properly correctly normally suddenly immediately subsequently eventually
   purchasing purchase purchases resulting caused causing
   occurred occurring occurs occur happened happening happens
   experienced experiencing experience noticed noticing notice
   began begin started starting attempted attempting attempt
   received receive receiving requested requesting request`.split(/\s+/)
);

/**
 * The distinctive terms two texts share — used to explain a similarity score with
 * words actually present in the reports rather than a canned phrase (§14/§17).
 *
 * Ranking favours module/protocol acronyms and version numbers, penalises terms that
 * appear in most of the corpus, and drops narrative filler entirely.
 */
export function sharedTerms(textA, textB, { corpusDf = null, totalDocs = 0, limit = 6 } = {}) {
  const a = new Set(tokenize(textA));
  const b = new Set(tokenize(textB));
  const shared = [...a].filter((t) => b.has(t) && !/^\d+$/.test(t) && !LOW_SIGNAL.has(t));
  if (!shared.length) return [];

  // Terms capitalised in either source are almost always module or protocol names
  // (BCM, OTA, ECU, TCU) — the most useful thing an explanation can cite.
  const acronyms = new Set(
    [
      ...String(textA || "").matchAll(/\b[A-Z]{2,6}\b/g),
      ...String(textB || "").matchAll(/\b[A-Z]{2,6}\b/g),
    ].map((m) => m[0].toLowerCase())
  );

  const score = (t) => {
    let s = 1;
    if (corpusDf && totalDocs) {
      const df = corpusDf.get(t) || 1;
      s = Math.log((1 + totalDocs) / (1 + df));
      // A term present in most reports explains nothing, however long it is.
      if (df / totalDocs > 0.6) s *= 0.2;
    }
    if (acronyms.has(t)) s += 2;
    if (/\d/.test(t)) s += 1.5; // software versions, campaign numbers
    if (t.length >= 8) s += 0.3; // reflashed, connectivity, immobilised
    return s;
  };

  return shared.sort((x, y) => score(y) - score(x)).slice(0, limit);
}

/** Document frequency across a corpus, for ranking which shared terms are meaningful. */
export function documentFrequency(texts) {
  const df = new Map();
  for (const t of texts) {
    for (const tok of new Set(tokenize(t))) df.set(tok, (df.get(tok) || 0) + 1);
  }
  return df;
}
