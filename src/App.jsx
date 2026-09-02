import { NavLink, Route, Routes } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import Intake from "./pages/Intake.jsx";
import Themes from "./pages/Themes.jsx";
import ThemeDetail from "./pages/ThemeDetail.jsx";
import Brief from "./pages/Brief.jsx";

export default function App() {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() =>
        setStatus({
          demoMode: true,
          engine: "Unavailable",
          engineDetail: "The analysis server is not reachable. Start it with `npm run server`.",
        })
      );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const live = status?.demoMode === false;
  const corpus = status?.corpus;

  return (
    <>
      <header className="app-header">
        <div className="brand-row">
          <div className="brand">
            <h1>VehiclePulse</h1>
            <p>Connected Vehicle Software Feedback Triage</p>
          </div>
          {/*
            §25 — the engine is always visible so nobody mistakes a rule-based result for a
            live one. It reports which engine is running and never anything about the key
            itself beyond whether one was found server-side.
          */}
          <div className="status-stack">
            <div className={`engine-chip ${live ? "live" : ""}`} title={status?.engineDetail || ""}>
              {live ? "● Live LLM" : "● Demo Mode"}
              {live && status?.model ? ` · ${status.model}` : ""}
            </div>
            {corpus && (
              <div className="status-line">
                {corpus.total.toLocaleString()} report{corpus.total === 1 ? "" : "s"}
                {corpus.real > 0 ? ` · ${corpus.real.toLocaleString()} NHTSA / Public` : ""}
                {corpus.pending > 0 ? ` · ${corpus.pending.toLocaleString()} not yet triaged` : ""}
                {corpus.failed > 0 ? ` · ${corpus.failed.toLocaleString()} failed` : ""}
              </div>
            )}
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Intake
          </NavLink>
          <NavLink to="/themes">Themes</NavLink>
          <NavLink to="/brief">Product Brief</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Intake status={status} onCorpusChange={refresh} />} />
        <Route path="/themes" element={<Themes />} />
        <Route path="/themes/:id" element={<ThemeDetail />} />
        <Route path="/brief" element={<Brief />} />
      </Routes>
    </>
  );
}
