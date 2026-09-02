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

If `GROQ_API_KEY` is not set, the app runs in **Demo Mode**:

- 40 seed reports and Themes work
- **Load example report** → **Analyze report** returns a pre-generated, reasoned result
- Arbitrary pasted text uses a context-aware heuristic (not keyword-only)

### Live LLM (optional)

1. Copy `.env.example` to `.env`
2. Set `GROQ_API_KEY` to your Groq API key
3. Optionally set `GROQ_MODEL` (default: `llama-3.3-70b-versatile`)
4. Restart `npm run dev`

The API key is read server-side only and never sent to the browser.

> **Embeddings:** Groq does not provide an embeddings API. Similarity search and theme clustering use local lexical vectors. If you also set `OPENAI_API_KEY`, semantic OpenAI embeddings (`text-embedding-3-small`) will be used instead.

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

- Frontend: Vite + React
- API: Express (Node.js)
- Database: sql.js (SQLite, persisted to `data/vehiclepulse.db`)
- LLM: Groq (`llama-3.3-70b-versatile` by default) via OpenAI-compatible API
- Embeddings: Local lexical vectors (TF-IDF/cosine hybrid); OpenAI `text-embedding-3-small` if `OPENAI_API_KEY` is set
- Similarity: TF-IDF + cosine, lexical candidate shortlisting
- Import: NHTSA flat file, CSV, TSV — auto-detected, no manual column mapping needed
