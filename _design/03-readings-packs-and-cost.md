# Readings Packs & Cost Design

Replaces the prior Vertex-AI cache-rebuild instructions. Vertex is no longer used; the Socratic chamber now calls Claude Haiku 4.5 via `@anthropic-ai/sdk` from `netlify/functions/chat.js`.

## Architecture

```
chamber.html → POST /.netlify/functions/chat → Anthropic Messages API
                          │
                          ├── reads ANTHROPIC_API_KEY from env
                          ├── per-IP rate limit (30 req / 5 min)
                          ├── last 6 turns only
                          ├── system: [Socratic prompt] + [optional pack readings]
                          └── ephemeral cache_control on the last system block
```

## Readings packs

The chat Function loads `data/packs/<pack_id>.txt` at request time and inlines the text into a cached system block. See `data/packs/README.md` for the pack-ID list, format, and size guidance.

If no pack file exists, the agent still works — it falls back to a one-line topic note. Quality is meaningfully better with packs in place because the agent can point students at specific passages.

### Current pack content (built 2026-05-01)

| Pack | Size (tokens, approx) | Notes |
|---|---:|---|
| `stage1_existentialism` | ~27K | Full coverage: Four Thinkers, Sartre/de Beauvoir/Camus overviews, Republic of Silence, Being and Nothingness excerpt |
| `stage1_virtue_compassion` | ~33K | Full coverage: Murdoch, Nussbaum (×2), Political Emotions excerpt |
| `stage1_religion_ethics` | ~20K | Full coverage: three Haidt depths + Righteous Mind fragments |
| `stage1_aesthetics` | ~28K | Full coverage: Wimsatt & Beardsley, Intentional/Unintentional, Theme 4, VCE Art chapter, Freeland |
| `stage1_mind_simulation` | ~37K | Full coverage: Identity Theory, Functionalism, Dualism, Materialism, Sim/Human-Being slides, Ravenscroft trio, Nagel |
| `lab_applied_normative_ethics` | ~22K | **Partial coverage** — see below |

### lab_applied_normative_ethics — known gap

Three readings in `readings_source/` are scanned-image PDFs (no extractable text layer): `judith.pdf` (Thomson — *A Defence of Abortion*), `marquis.pdf` (Marquis — *Why Abortion is Immoral*), and `Singer Abortion.pdf`. OCR via tesseract is technically feasible but slow on the build host (~2-12 min per page × 25 pages).

The lab pack therefore currently grounds the agent in: Brave New World Ch. 16, *When We Die*, Gilligan's *In a Different Voice*, and an excerpt of Singer's *Practical Ethics*. Claude has all three missing readings in its training data and can discuss Thomson's violinist, Marquis's future-like-ours argument, and Singer's personhood criteria without grounded text — it just can't quote specific lines from the class PDFs the way it does for the other 5 packs.

To enrich this pack later: OCR the three PDFs into `extracted/readings_source/{judith,marquis,Singer Abortion}.txt` (the tooling lives at `/tmp/run_ocr4.sh` in this build, but any OCR pipeline works) and re-run the assembly script.

## Cost model

Haiku 4.5: **$1 per million input tokens, $5 per million output tokens.** Prompt caching: 1.25× input price for cache writes, 0.1× for cache reads (5-minute ephemeral TTL).

A typical Socratic exchange:
- ~1.5K tokens in (system + history) + ~300 tokens out → $0.003 per turn uncached
- With a 30K-token cached pack: first turn ~$0.04 (cache write), subsequent turns within 5 min ~$0.005 (cache read)

For a class of 14 students × ~20 turns over a 5-week unit:
- ~$3 if the cache stays warm throughout active sessions
- ~$15–25 if students hit the chamber sporadically (more cache writes)

A **monthly spend cap** in `console.anthropic.com` is the structural guard against runaways (alongside the per-IP rate limit and history truncation in the Function).

## Knobs in `chat.js`

| Constant | Default | Purpose |
|---|---|---|
| `MODEL` | `claude-haiku-4-5` | Cheap, fast, good Socratic discipline |
| `MAX_OUTPUT_TOKENS` | 600 | Caps response length; matches the "2-4 sentence" instruction |
| `HISTORY_TURN_LIMIT` | 6 | Last N user/assistant pairs sent to the API |
| `RATE_LIMIT_MAX` | 30 | Requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | 300000 | Sliding window in ms (5 minutes) |

The rate limiter is in-memory per Function container. It throttles a single misbehaving client effectively but isn't a globally consistent limit; pair with the spend cap in the Anthropic console.

## Token-usage logs

Every chat request logs a structured line to Netlify's function logs:

```json
{"event":"chat.usage","ip":"...","pack":"stage1_aesthetics","input_tokens":1820,"output_tokens":214,"cache_creation_input_tokens":31200,"cache_read_input_tokens":0}
```

To audit cost: `netlify functions:log chat | grep chat.usage`.

## Operational notes

- **API key rotation:** the key lives in Netlify env vars (`ANTHROPIC_API_KEY`). Rotate by setting a new one in `console.anthropic.com` → API Keys, updating the env var in Netlify, redeploying.
- **Adding a pack:** drop `data/packs/<pack_id>.txt`, add the topic to `PACK_CONTEXT` in `chat.js`, and add a chip in `chamber.html`. No rebuild step; the Function picks it up on next cold start.
- **Removing a pack:** delete the file. Function falls back to the topic note automatically.
- **Local dev:** `netlify dev` reads `.env` automatically. The repo's `.gitignore` already excludes `.env`.
