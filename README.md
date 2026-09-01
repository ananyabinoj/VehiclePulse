# VehiclePulse

Internal OEM support desk for converting messy connected-vehicle software feedback into explainable triage and recurring product themes.

## Run locally

```bash
cd "D:\trial vs\PRO"
npm install
npm run dev
```

Then open **http://localhost:5173**

- API: `http://127.0.0.1:8787`
- UI (Vite proxy): `http://localhost:5173`

### Demo Mode (default)

If `OPENAI_API_KEY` is not set, the app runs in **Demo Mode**:

- 40 seed reports and Themes work
- **Load example report** → **Analyze report** returns a pre-generated, reasoned result
- Arbitrary pasted text uses a context-aware heuristic (not keyword-only)

### Live LLM (optional)

1. Copy `.env.example` to `.env`
2. Set `OPENAI_API_KEY`
3. Restart `npm run dev`

## 3-minute demo

1. Open Intake
2. Click **Load example report**
3. Click **Analyze report**
4. Read triage recommendation + reasons + similar reports
5. Open **Themes**, click **OTA Updates Failing After Vehicle Sleep**
6. Read the product improvement
7. Open **Product Brief**

## Production-style start

```bash
npm install
npm run build
npm start
```

Serves the API and built UI on port **8787**.

## Stack

Vite + React frontend, Express API, sql.js (SQLite) seed database, optional OpenAI JSON classification, TF-IDF/cosine hybrid duplicate matching.
