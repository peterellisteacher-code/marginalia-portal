# Per-student portal — deployment notes

Built 2026-05-28. Extends the Marginalia site so each Year 11 student has a personal portal with a Socratic AI research agent that can search YouTube, read video transcripts, and curate a per-student resource shelf.

## What's new in this layer

| Path | Purpose |
|---|---|
| `index.html` | Now also serves as the landing page with a 9-button name picker + password modal. Hero copy unchanged. |
| `portal.html` | The per-student page: working question, chat with the Socratic agent, resource shelf with ✕-removal, pinned-questions strip. |
| `shared/portal.js` | Frontend wiring — verifies session, loads state, autosaves working question, sends chat, renders resource cards. |
| `netlify/functions/auth.js` | POST /auth — actions: `list`, `login`, `verify`. Verifies password (case-insensitive surname) and issues HMAC-signed session tokens (8h lifetime). |
| `netlify/functions/_lib/registry.js` | Roster of the 9 students. First names + surname-passwords. No surnames are ever rendered to the page. |
| `netlify/functions/_lib/session.js` | HMAC token issue/verify. |
| `netlify/functions/portal-state.js` | POST /portal-state — actions: `load`, `set_working_question`, `add_resource`, `remove_resource`. Stores per-student JSON in Netlify Blobs (`marginalia-students` store, key `students/<id>/state.json`). Shelf cap: 30 resources. |
| `netlify/functions/youtube-search.js` | POST /youtube-search — wraps YouTube Data API v3. Safe-search strict, English, embeddable. |
| `netlify/functions/youtube-transcript.js` | POST /youtube-transcript — fetches captions via the `youtube-transcript` npm package. Best-effort; returns `ok:false` with a graceful fallback if captions aren't available. |
| `netlify/functions/chat.js` | Rewritten for OpenRouter routing + multi-turn tool-use. Tools: `youtube_search`, `youtube_transcript`, `add_resource`, `set_working_question`. Cached readings (all 6 packs concatenated, ~103K tokens) inlined as one ephemeral-cache breakpoint. Backward-compatible with `chamber.html` (anonymous mode drops state-mutating tools and the student context block). |

## Required Netlify env vars

```bash
netlify env:set OPENROUTER_API_KEY "sk-or-v1-..."         # main chat routing
netlify env:set YOUTUBE_API_KEY "AIza..."                  # YouTube Data API v3
netlify env:set SESSION_SECRET "$(openssl rand -hex 32)"   # HMAC token signing
```

`ANTHROPIC_API_KEY` is no longer used — `chat.js` calls Anthropic via OpenRouter's compatibility endpoint. You may revoke the old Anthropic key once production is verified.

## Student roster

| First name | Button label | Password (lowercase surname, case-insensitive) |
|---|---|---|
| Abigail | "Abigail" | lindsay |
| Annabel | "Annabel" | wood |
| Clare | "Clare" | palmer |
| Grace | "Grace" | ryder |
| James | "James" | norris |
| Jim | "Jim" | howie |
| Millicent | "Millicent" | gilbert-rugless |
| Porsha | "Porsha" | bates |
| Ripley | "Ripley" | valentine |

(James Howie → button label "Jim" to disambiguate from James Norris.)

## Trust model

This is a classroom-internal site. The "password" is a lowercase surname, which has minimal entropy against motivated classmates — but the per-student state is also low-stakes (research links, working question text). The HMAC-signed session tokens stop casual URL fishing; the Netlify Function gate stops direct Blob reads.

If a stricter posture is wanted later: swap the registry to store `sha256(surname)` instead of plaintext, and gate the landing page itself behind Netlify Identity.

## How the agentic chat works

1. Student types a message in the portal.
2. `portal.js` POSTs `{token, message, history}` to `/.netlify/functions/chat`.
3. `chat.js` authenticates the token, loads the student's state from Blobs.
4. Builds a system prompt with: Socratic + plain-language rules, all 6 cached readings (ephemeral cache), student context (name, working question, current shelf).
5. Calls Claude Haiku 4.5 via OpenRouter (`~anthropic/claude-haiku-latest`).
6. If the model emits `tool_use` blocks, executes them locally and feeds results back. Up to 6 tool-use loops per chat turn.
7. When the model stops with `end_turn`, returns the text plus any resources added or working-question updates to the client.
8. `portal.js` re-renders the shelf and flashes the working-question field if the agent edited it.

## Plain-language UX (per the unified instructions guide)

The Socratic system prompt is explicitly instructed to:
- Target FK ~8 sentences when explaining hard passages.
- Define hard words inline on first use.
- Use one word per concept consistently.
- Keep replies to 2–4 sentences unless reporting on a tool call.

The student-side affordance is the **"Explain plainly"** button on each resource card: click sends a templated message ("Can you explain '<title>' to me in plain English, like I'm new to philosophy?") that triggers the plain-language branch of the system prompt.

## What's intentionally NOT built (for next session)

- Per-message "Explain plainly" button on agent chat bubbles (currently only on resource cards). Student can still type "what does that mean?" manually.
- Web search beyond YouTube. The agent has rich training-data knowledge of canonical philosophy texts; full open web search would need a Brave/SerpAPI key.
- Direct video reading via `google/gemini-3.1-flash-lite-preview`. We use the transcript-fetch path instead — cheaper and works for any captioned video. Multimodal video reading is a follow-on if transcripts prove insufficient.
- A way to share/export the resource shelf as a study list.
- Teacher-side dashboard to peek at student progress.

## Smoke test plan after deploy

1. Visit `/` — see 9 name buttons. Two-Jameses are labelled "James" and "Jim".
2. Click any name → modal opens.
3. Wrong password → error inline.
4. Correct password → land on `portal.html`, welcome line shows first name.
5. Type a question in the chat → agent replies within ~3s with a Socratic question.
6. Ask the agent to find a video → check that a card appears on the shelf with ✕ button.
7. Click ✕ → card disappears; reload → still gone.
8. Type a working question → blur → "Saved" appears.
9. Click "Log out" → back to landing.
10. Anonymous test: visit `/chamber.html` (no login) → chat still works, tools restricted to youtube_search.
