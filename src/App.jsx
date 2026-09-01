import { NavLink, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import Intake from "./pages/Intake.jsx";
import Themes from "./pages/Themes.jsx";
import ThemeDetail from "./pages/ThemeDetail.jsx";
import Brief from "./pages/Brief.jsx";

export default function App() {
  const [mode, setMode] = useState(null);

  useEffect(() => {
    fetch("/api/mode")
      .then((r) => r.json())
      .then(setMode)
      .catch(() => setMode({ demoMode: true, hint: "API not reachable yet." }));
  }, []);

  return (
    <>
      <header className="app-header">
        <div className="brand-row">
          <div className="brand">
            <h1>VehiclePulse</h1>
            <p>Connected Vehicle Software Feedback Triage</p>
          </div>
          {mode?.demoMode !== false && (
            <div className="demo-chip" title={mode?.hint || ""}>
              Demo Mode — no API key configured
            </div>
          )}
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
        <Route path="/" element={<Intake mode={mode} />} />
        <Route path="/themes" element={<Themes />} />
        <Route path="/themes/:id" element={<ThemeDetail />} />
        <Route path="/brief" element={<Brief />} />
      </Routes>
    </>
  );
}
