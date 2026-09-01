import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, listReports, getReport, searchReports } from "./db.js";
import { analyzeReport } from "./analyze.js";
import { findSimilar } from "./similarity.js";
import { buildThemes, dashboardStats } from "./themes.js";
import { DEMO_EXAMPLES } from "./demoExamples.js";
import { SEVERITY_LABELS, SEVERITY_WEIGHTS } from "./seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const isDemo = () => !process.env.OPENAI_API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, demoMode: isDemo() });
});

app.get("/api/mode", (_req, res) => {
  res.json({
    demoMode: isDemo(),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    hint: isDemo()
      ? "Demo Mode is on because OPENAI_API_KEY is not set. Seed data, themes, and example analyses still work. Add the key to a .env file in the project root to enable live LLM classification."
      : "Live LLM analysis is enabled.",
  });
});

app.get("/api/demo-examples", (_req, res) => {
  res.json(DEMO_EXAMPLES.map(({ id, title, text }) => ({ id, title, text })));
});

app.get("/api/reports", (req, res) => {
  const { q, theme, model } = req.query;
  const rows =
    q || theme || model ? searchReports({ q, theme, model }) : listReports();
  res.json(rows);
});

app.get("/api/reports/:id", (req, res) => {
  const row = getReport(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

app.get("/api/filters", (_req, res) => {
  const reports = listReports();
  const uniq = (fn) => [...new Set(reports.map(fn).filter(Boolean))].sort();
  res.json({
    severities: ["P0", "P1", "P2", "P3"],
    subsystems: uniq((r) => r.subsystem),
    models: uniq((r) => r.vehicleModel),
    versions: uniq((r) => r.softwareVersion),
    owners: uniq((r) => r.suggestedOwner),
    themes: uniq((r) => r.theme),
  });
});

app.get("/api/themes", (req, res) => {
  const reports = listReports();
  let themes = buildThemes(reports);
  const { severity, subsystem, model, version, owner } = req.query;
  if (severity || subsystem || model || version || owner) {
    themes = themes
      .map((t) => {
        const filtered = t.reports.filter((r) => {
          if (severity && r.severity !== severity) return false;
          if (subsystem && r.subsystem !== subsystem) return false;
          if (model && r.vehicleModel !== model) return false;
          if (version && r.softwareVersion !== version) return false;
          if (owner && r.suggestedOwner !== owner) return false;
          return true;
        });
        if (!filtered.length) return null;
        return { ...t, reports: filtered, reportIds: filtered.map((r) => r.id), reportCount: filtered.length };
      })
      .filter(Boolean);
  }
  const stats = dashboardStats(reports, buildThemes(reports));
  res.json({
    stats,
    heuristic:
      "Priority = affected vehicles × severity weight (P0=10, P1=5, P2=2, P3=1). This is VehiclePulse's MVP prioritization heuristic, not an industry standard.",
    weights: SEVERITY_WEIGHTS,
    themes: themes.map((t) => stripReports(t)),
  });
});

app.get("/api/themes/:id", (req, res) => {
  const themes = buildThemes(listReports());
  const theme = themes.find((t) => t.id === req.params.id);
  if (!theme) return res.status(404).json({ error: "Not found" });
  res.json(theme);
});

app.post("/api/analyze", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Paste a report first." });
  try {
    const triage = await analyzeReport(text, {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
    });
    const similar = findSimilar(text, listReports(), 3);
    res.json({
      demoMode: isDemo(),
      analysisSource: triage.source,
      labels: SEVERITY_LABELS,
      triage,
      similar,
      noStrongDuplicates: similar.length === 0,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function stripReports(t) {
  const { reports, ...rest } = t;
  return rest;
}

const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) next();
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VehiclePulse API http://127.0.0.1:${PORT}  demoMode=${isDemo()}`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
