# Marginalia — SACE Stage 1 Philosophy Issues Study

A polished portal for Year 11 Philosophy students working on the Issues Study (Assessment Type 3, 800 words / 5 min / multimodal). Static site + Netlify Function calling the Anthropic Claude API.

## What this is

| Page | Purpose |
|---|---|
| `index.html` | Welcome + class-roster login (the only page reachable logged out) |
| `portal.html` | Per-student desk: working question, AI agent, resource shelf, reading packs |
| `explainer.html` | What is an Issues Study? Five principles + A-vs-C exemplar comparison |
| `bank.html` | 117 philosophical questions, filterable by key area + difficulty + search; pin to revisit |
| `lab.html` | Thought-experiment lab; choices persist per student |
| `exemplars.html` | The Showroom — exemplar gallery with the Curator agent |
| `chamber.html` | Socratic AI agent — same persistent conversation thread as the portal |
| `resources.html` | The class readings library, with chamber links |
| `drafting.html` | Five-section drafting scaffold; autosaves per student to the server |

**Auth model:** every page except `index.html`/`404.html` requires login
(`shared/guard.js` redirects logged-out visitors to the welcome page). The
session is an HMAC-signed token (30 days) in `localStorage` under
`marginalia.session` — shared across tabs, survives restarts. All functions
(`chat`, `portal-state`) reject requests without a valid token; the page
gate is client-side JS (workflow, not cryptography), the function gate is
the real boundary.

**Per-student state** lives in Netlify Blobs (store `marginalia-students`):
`students/<id>/state.json` for the portal (question, shelf, chat history,
active pack) and `students/<id>/pages/<page>.json` for per-page state
(`draft`, `pins`, `lab`). Each page mirrors to a per-student localStorage
key for offline resilience; the server is the cross-device source of truth.

Aesthetic identity: **Marginalia** — philosophy as a 2,500-year tradition of writing in the margins of texts. See `_design/02-aesthetic-brief.md`.

Pedagogical and aesthetic briefs live in `_design/`.

## Architecture

```
Browser ──HTTPS──▶ Netlify (static + Functions) ──HTTPS──▶ OpenRouter ──▶ Claude Haiku 4.5
                        │
                        ├── auth.js          login / token verify (HMAC, _lib/session.js)
                        ├── chat.js          Socratic agent (login required, all modes)
                        ├── portal-state.js  per-student state in Netlify Blobs
                        └── youtube-*.js     agent tool backends
```

Static HTML/CSS/JS plus four Netlify Functions. `chat.js`:
1. Requires a valid session token (every mode — there is no anonymous AI access)
2. Calls Claude Haiku 4.5 via OpenRouter (direct `fetch`, provider pinned to Anthropic — never the Anthropic SDK against OpenRouter)
3. Always enforces the Socratic system prompt (never writes the essay)
4. Optionally accepts a `pack` (topic) parameter to inline one cached readings pack
5. Uses prompt caching on the long stable prefix

## File tree

```
website/
├── index.html            ← welcome
├── explainer.html        ← assignment explainer + A/C exemplars
├── bank.html             ← question bank with filters & pins
├── chamber.html          ← Socratic AI chat interface
├── resources.html        ← class readings library
├── drafting.html         ← drafting scaffold with word count
├── shared/
│   ├── tokens.css        ← design tokens (Marginalia palette + 8px grid + Perfect Fourth scale)
│   ├── marginalia.css    ← shared component styles
│   └── pins.js           ← session-storage pinned-question state
├── data/
│   └── questions.json    ← 117 questions across 20 clusters
├── netlify/
│   └── functions/
│       └── chat.js       ← Anthropic Claude proxy (the only server-side code)
├── netlify.toml          ← deployment config
├── package.json          ← @anthropic-ai/sdk dep
├── .gitignore
├── _design/              ← briefs (not deployed but committed)
│   ├── 01-pedagogical-brief.md
│   └── 02-aesthetic-brief.md
└── README.md             ← this file
```

## Local development

```bash
npm install
netlify dev          # starts local server with functions on http://localhost:8888
```

You'll need `netlify-cli` installed globally (`npm i -g netlify-cli`) and the `ANTHROPIC_API_KEY` env var set locally (e.g. via `netlify env:set` or a `.env` file).

## Environment variables (set in Netlify site settings)

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Anthropic API key. Generate at `console.anthropic.com` → API Keys. Set a monthly spend cap there as a safety net. |

To set the API key in Netlify (recommended — never commit, never paste in chat):

```bash
netlify env:set ANTHROPIC_API_KEY "sk-ant-api03-..."
```

Or via the Netlify UI: *Site settings → Environment variables → Add variable*, name `ANTHROPIC_API_KEY`, mark it as a secret so it's masked in the dashboard.

## Cost

Claude Haiku 4.5 is priced at $1 per million input tokens and $5 per million output tokens. A typical Socratic exchange runs about 1-2k input tokens and ~300 output tokens, so a class of 30 students doing ~20 turns each over the unit lands at well under $5 total. Set a monthly spend cap in the Anthropic console as a structural guard against runaways.

## Deployment

The site deploys via GitHub → Netlify. Pushing to `main` triggers an auto-deploy.

## Why Netlify (not GitHub Pages)

- GitHub Pages is static-only — no serverless functions. The Anthropic proxy needs server-side execution to keep the API key secret.
- Netlify provides static hosting AND serverless functions in one platform.
- Per the user: students at school cannot access github.io domains, but can access netlify.app.

## Pedagogical commitments encoded in the code

- The Socratic system prompt in `chat.js` explicitly forbids the agent from writing the essay or generating questions for the student.
- The question bank requires every entry to be phrased as a *question* (not a topic) — this is the single most impactful move per SACE's 2025 assessment advice.
- The drafting scaffold structures the work in the order the assessment expects: question → multiple positions → critical analysis → defended position → sources.
- The A-vs-C exemplar comparison surfaces the difference between description and analysis up front.

See `_design/01-pedagogical-brief.md` for the full mapping of site sections to SACE Stage 1 Philosophy performance standards.
