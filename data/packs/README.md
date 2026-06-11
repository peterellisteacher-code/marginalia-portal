# Readings packs

Drop one plain-text file per topic here. The chat Function (`netlify/functions/chat.js`) loads `data/packs/<pack_id>.txt` at request time and inlines it into a cached system block, so the agent can quote the readings.

If a pack file is missing, the chat still works — it falls back to a one-line topic note ("you're working in the existentialist tradition...") and Claude reasons from training-data familiarity. With the pack file present, the agent can point at specific passages.

## Pack IDs the Function recognises

| File | Topic |
|---|---|
| `stage1_existentialism.txt` | Sartre, de Beauvoir, Camus, Heidegger, Kierkegaard |
| `stage1_virtue_compassion.txt` | Murdoch on attention, Nussbaum on compassion |
| `stage1_religion_ethics.txt` | Haidt on moral binding |
| `stage1_aesthetics.txt` | Wimsatt & Beardsley, intentional fallacy |
| `stage1_mind_simulation.txt` | Identity theory, functionalism, dualism, simulation |
| `lab_applied_normative_ethics.txt` | Singer, Marquis, Thomson, Brave New World |
| `stage1_reason_passion.txt` | Plato (Republic, Phaedrus) & Aristotle (Nicomachean Ethics) — reason vs. instinct/passion |
| `stage1_personal_identity.txt` | Parfit, "Personal Identity" (1971) full text — fission, q-memory, survival without identity |

The pack ID matches the `data-pack` attribute on the topic chips in `chamber.html`. There is no allow-list to edit in `chat.js` — it loads `data/packs/<id>.txt` by filename. To add a new topic: drop the `.txt` here, add the id to `VALID_PACKS` in `netlify/functions/portal-state.js`, and add a chip in `chamber.html` and `portal.html` (optionally a `packMap` entry and a `resources.html` card).

## Format

- Plain UTF-8 text. No frontmatter, no markdown is required (but markdown headings work fine).
- Paste extracted text from each reading, separated by clear headings:

```
=== Iris Murdoch — The Sovereignty of Good ===
[reading body...]

=== Martha Nussbaum — Compassion and Reason ===
[reading body...]
```

- Trim aggressively. The agent is steering the student, not running a literature review — passages that show *the move being made* are more useful than long expository paragraphs.

## Size guidance

| Pack size | Cost behaviour |
|---|---|
| < 4096 tokens (~3000 words) | Caching does not activate. Tokens billed at full rate every turn. |
| 4096 – 30,000 tokens | Caching activates. First turn pays write cost (~1.25× input rate); subsequent turns within 5 minutes pay read cost (~0.1× input rate). Sweet spot. |
| 30,000 – 100,000 tokens | Still cached. Read cost stays cheap, but the first turn (cache write) is more expensive. Fine for a class; check if you're worried about cost. |
| > 100,000 tokens | Approaching Haiku 4.5's 200K context window. Trim. |

A reasonable default: **20–60K tokens per pack** (~15–45K words / ~30–80 pages of dense prose). Prioritise the 2–4 most-cited passages per philosopher rather than a full chapter.

## Extracting text from PDFs

```bash
# Linux / macOS
pdftotext -layout reading.pdf reading.txt

# Windows (PowerShell, requires Word installed)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$d = $word.Documents.Open("C:\full\path\to\reading.pdf")
$d.SaveAs("C:\full\path\to\reading.txt", 7)  # 7 = wdFormatText
$d.Close()
$word.Quit()
```

Then concatenate the per-reading text files into the pack file with `=== Title ===` headings as separators.

## Cost & caching notes

- The Function marks the LAST system block with `cache_control: { type: "ephemeral" }`. That breakpoint caches everything before it (the Socratic system prompt + the readings pack).
- Ephemeral cache lives for ~5 minutes, refreshed by every request that hits the same prefix. While a class is actively chatting, cache stays warm.
- The Socratic system prompt is roughly 900 tokens — well under the 4096-token minimum — so it only caches *together* with a readings pack. If you don't supply a pack, no caching happens, but cost is still minimal because nothing big is in the prefix.
