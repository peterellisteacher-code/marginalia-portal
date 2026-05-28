/**
 * chat.js -- Netlify Function: Socratic agent + research tools
 *
 * POST /.netlify/functions/chat
 * Body: { token, message, history }
 * Returns: { reply, resources_added?, working_question_set? }
 *
 * - Routes Claude Haiku 4.5 via OpenRouter (single billing surface).
 * - Multi-turn tool-use loop. Tools: youtube_search, youtube_transcript,
 *   add_resource, set_working_question.
 * - Inlines the six Stage 1 cache packs as a single cached system block
 *   so the agent can quote primary texts when the student needs them.
 * - Per-student state (working question + resources) lives in Netlify Blobs,
 *   loaded once at start of each chat call.
 *
 * Env: OPENROUTER_API_KEY, YOUTUBE_API_KEY, SESSION_SECRET
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { YoutubeTranscript } = require('youtube-transcript');

const { authenticate } = require('./_lib/session');
const { getStudent } = require('./_lib/registry');

// Pinned to a specific Haiku version for the duration of the unit; latest-
// pointer slugs can silently drift to a new model mid-term, changing
// behaviour without notice.
const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_OUTPUT_TOKENS = 800;
const HISTORY_TURN_LIMIT = 6;
const MAX_TOOL_LOOPS = 6;
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const SHELF_CAP = 30;

// ----------------------------------------------------------------------
// Socratic system prompt -- shaped by:
//   - SACE Stage 1 Issues Study tasksheet (AT3, 800w/5min/multimodal)
//   - "Writing Clear Instructions for Complex Tasks" guide (FK 7-9, active
//     voice imperative, one concept = one word, define-on-first-use)
//   - "When and How to Reveal Information" guide (just-in-time definitions,
//     no front-loading, click-triggered popovers when the student asks)
// ----------------------------------------------------------------------

const SOCRATIC_SYSTEM_PROMPT = `You are the agent (the student's name for you on the site) — a Socratic interlocutor for a Year 11 student doing the SACE Stage 1 Philosophy Issues Study (Assessment Type 3).

THE ASSESSMENT THE STUDENT IS WORKING TOWARD
800 words written, or 5 minutes oral, or equivalent multimodal. The student must:
1. Choose a philosophical question — their own, negotiated with their teacher.
2. Identify multiple positions on that question.
3. Explain the reasons behind at least one position they do NOT hold.
4. Analyse those other positions critically.
5. Defend their own position with logic and evidence.
6. Use philosophical terminology accurately.

The four marking criteria are Knowledge & Understanding, Reasoning, Critical Analysis, and Communication.

YOUR JOB
Help the student sharpen what they already half-think. You ask one short question at a time. You do not write any part of the essay. You do not tell the student what to think.

WHEN TO USE YOUR TOOLS
You have four tools. Use them sparingly and only when they help.

- youtube_search: Use when the student needs an entry point — a thinker they have not met, a position they cannot name, a debate they are gesturing at. Search returns up to 5 videos. Pick the best one or two and add them to the shelf using add_resource.
- youtube_transcript: Use AFTER the student has watched a video they named. Read the transcript so you can ask them what they took from it. Do not read it before — that ruins the watch.
- add_resource: Use when you have found something the student should keep. Always say in your reply what you added and why, in plain words. Keep the title ≤140 characters. Keep the description ≤280 characters and at Year 11 reading level.
- set_working_question: Use ONLY when the student has explicitly committed to a refined version of their question. Confirm in your next reply.
- update_progress_notes: After any meaningful shift in the student's thinking — a position they are now taking seriously, a reading they have processed, a refined question — save a short snapshot (≤500 chars) of where they are up to and how they are approaching the problem. These notes feed back into your context on every future turn, so future-you can pick up where past-you left off. Update them as a snapshot (replaces previous), not a log (do not accumulate).

PLAIN-LANGUAGE RULES — WHEN YOU EXPLAIN HARD IDEAS
The cached readings below are academic philosophy (Murdoch, Sartre, Haidt, Nussbaum, Wimsatt & Beardsley, etc.). They are written for adults. The student reads at about Year 8 level when tired or anxious.

If the student asks you to explain a passage, or asks "what does that mean?", or clicks "Explain plainly":
- Sentences average around 14 words. Never longer than 25.
- Active voice. Use "you" or the thinker's name as the subject — not "one" or "it is the case that".
- Define any hard word on first use, inline, in parentheses: "a *veil* (a thin cover that hides what's behind it)".
- Use the same word for the same concept throughout. Do not switch between "the unconscious", "below awareness", and "the hidden mind".
- Give a concrete example or scene when it helps. ("Imagine you have walked into a room and felt that someone there does not like you. Murdoch is saying that what you 'see' in that moment is already a moral act.")
- Keep the philosophical move intact. Plain language is not dumbing down. Murdoch's claim still needs to be Murdoch's claim — just in words a 16-year-old can carry.

WHEN YOU QUOTE A READING
- Quote at most three short sentences at a time.
- After the quote, name the move ("She is saying that…") in one sentence.
- Then ask a question. Do not pre-explain unprompted.

HOW YOU ASK QUESTIONS
- One question per turn. Then stop.
- When the student gives a topic ("ethics", "the brain", "art"), press: "What about that catches your attention? Was there a moment, a story, a piece of news that drew you in?"
- When the student gives a position, ask: "What is the strongest objection?"
- When the student wants to know what a philosopher thinks, point them at a reading or video — do not summarise unprompted.
- Use philosophical terminology accurately. If the student gestures at a concept without knowing the word, name it once: "There's a word for that. Sartre calls it *bad faith* — lying to yourself about how free you are."
- Register thinking, not effort: "That's a sharper formulation." "But what would [other position] say to that?" Avoid generic praise ("great question!", "well done!").

LIMITS
- 2–4 sentences per turn, unless you are reporting back on a tool call.
- Never write paragraphs of philosophy for the student.
- Never write any portion of the essay.
- If the student asks you to write it: "That would do the thinking the assessment is asking you to do. Let me ask a question that might help instead…"

The student's identity, working question, and current resource shelf appear in the context block before their first message. Use them.`;

// ----------------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------------

const TOOLS = [
    {
        name: 'youtube_search',
        description:
            'Search YouTube for educational videos on a philosophical topic, thinker, or argument. Returns up to 5 videos with title, description, thumbnail, and videoId. Use sparingly — only when the student needs an entry point they do not have.',
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query. Be specific: "Thomson violinist argument abortion", not just "abortion".',
                },
                max_results: {
                    type: 'integer',
                    description: 'Up to 5. Default 5.',
                    default: 5,
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'youtube_transcript',
        description:
            'Fetch the transcript of a YouTube video the student says they have watched. Use only AFTER the student names a video they watched — never before, so you do not spoil it. Returns transcript text or an explanation if captions are unavailable.',
        input_schema: {
            type: 'object',
            properties: {
                videoId: {
                    type: 'string',
                    description: 'The 11-character YouTube video id (NOT the full URL).',
                },
            },
            required: ['videoId'],
        },
    },
    {
        name: 'add_resource',
        description:
            'Add a resource (web link or YouTube video) to the student\'s shelf so they can find it later. The student can remove it with a click. Always tell the student in your reply what you added and why.',
        input_schema: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    enum: ['web', 'youtube', 'note'],
                    description: '"youtube" for videos, "web" for articles/pages, "note" for a key idea worth pinning.',
                },
                title: { type: 'string', description: 'Title of the resource. ≤140 characters.' },
                url: { type: 'string', description: 'Full http(s) URL.' },
                description: {
                    type: 'string',
                    description: 'Why this resource is useful, in plain Year-11-friendly language. ≤280 characters.',
                },
                videoId: { type: 'string', description: 'YouTube videoId (required if kind=youtube).' },
                thumbnail: { type: 'string', description: 'Thumbnail URL (optional, for YouTube).' },
            },
            required: ['kind', 'title', 'description'],
        },
    },
    {
        name: 'set_working_question',
        description:
            'Update the student\'s saved working question. Use ONLY when the student has explicitly committed to a refined version. Confirm in your reply.',
        input_schema: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'The refined philosophical question, ≤500 characters, ending with "?".',
                },
            },
            required: ['question'],
        },
    },
    {
        name: 'update_progress_notes',
        description:
            'Save a short running summary of where this student is up to, what their current question is, and how they are approaching it. Replaces the previous notes entirely (it is a snapshot, not a log). Update after meaningful shifts in their thinking — a new position they are taking seriously, a reading they have processed, a refined question. ≤500 characters. The notes feed back into your context on every future turn, so be specific and dated in your phrasing.',
        input_schema: {
            type: 'object',
            properties: {
                notes: {
                    type: 'string',
                    description: 'Snapshot of the student\'s current state and approach. ≤500 chars.',
                },
            },
            required: ['notes'],
        },
    },
];

// ----------------------------------------------------------------------
// Module-level caches (warm across invocations within a Function container)
// ----------------------------------------------------------------------

let anthropicClient = null;
let cachedPacksText = null;
const rateBuckets = new Map();

function getClient() {
    if (anthropicClient) return anthropicClient;
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not set. Configure in Netlify env vars.');
    }
    anthropicClient = new Anthropic({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
            'HTTP-Referer': 'https://marginalia.netlify.app',
            'X-Title': 'Marginalia — Stage 1 Issues Study',
        },
    });
    return anthropicClient;
}

function loadAllPacks() {
    if (cachedPacksText !== null) return cachedPacksText;
    const packsDir = path.join(__dirname, '..', '..', 'data', 'packs');
    let combined = '';
    try {
        const files = fs.readdirSync(packsDir).filter(f => f.endsWith('.txt'));
        for (const f of files) {
            try {
                const body = fs.readFileSync(path.join(packsDir, f), 'utf8');
                combined += `\n\n${body}\n`;
            } catch (e) {
                console.error('loadAllPacks: failed to read pack file', f, e.message);
            }
        }
    } catch (e) {
        // Most likely cause: data/packs/*.txt not included in netlify.toml
        // [functions].included_files. The agent will still answer, but it
        // cannot quote primary text.
        console.error(
            'loadAllPacks: packs directory not readable. Check that ' +
            'netlify.toml includes data/packs/*.txt in [functions].included_files.',
            e.message
        );
        combined = '';
    }
    cachedPacksText = combined;
    return combined;
}

// ----------------------------------------------------------------------
// Per-student state (Netlify Blobs)
// ----------------------------------------------------------------------

function studentStore() {
    // @netlify/blobs v8.2 with the connectLambda() bootstrap (called once
    // per handler invocation, see the exports.handler below) -- getStore by
    // name resolves credentials from the lambda context the bootstrap reads.
    // Edge access (eventual consistency, ~60s drift). Strong consistency needs
    // a personal access token Lambda-compat doesn't auto-wire. Eventual is
    // fine for a 9-student classroom — same trade-off as portal-state.js.
    return getStore({ name: 'marginalia-students' });
}

async function loadStudentState(store, studentId) {
    const key = `students/${studentId}/state.json`;
    const data = await store.get(key, { type: 'json' });
    if (data && typeof data === 'object') {
        return {
            workingQuestion: typeof data.workingQuestion === 'string' ? data.workingQuestion : '',
            resources: Array.isArray(data.resources) ? data.resources : [],
            chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory : [],
            progressNotes: typeof data.progressNotes === 'string' ? data.progressNotes : '',
        };
    }
    return { workingQuestion: '', resources: [], chatHistory: [], progressNotes: '' };
}

async function saveStudentState(store, studentId, state) {
    const key = `students/${studentId}/state.json`;
    await store.setJSON(key, { ...state, updatedAt: Date.now() });
}

// ----------------------------------------------------------------------
// Tool executors
// ----------------------------------------------------------------------

async function execYoutubeSearch({ query, max_results }) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return { error: 'YouTube search is not configured.' };
    const params = new URLSearchParams({
        part: 'snippet',
        q: String(query).slice(0, 200),
        type: 'video',
        maxResults: String(Math.min(Math.max(1, Number(max_results) || 5), 8)),
        safeSearch: 'strict',
        relevanceLanguage: 'en',
        videoEmbeddable: 'true',
        key: apiKey,
    });
    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    try {
        const r = await fetch(url);
        if (!r.ok) return { error: `YouTube returned ${r.status}.` };
        const data = await r.json();
        const results = (data.items || []).map(item => ({
            videoId: item.id?.videoId,
            title: stripEntities(item.snippet?.title || ''),
            description: stripEntities((item.snippet?.description || '').slice(0, 280)),
            channelTitle: item.snippet?.channelTitle || '',
            publishedAt: item.snippet?.publishedAt || '',
            thumbnail:
                item.snippet?.thumbnails?.high?.url ||
                item.snippet?.thumbnails?.medium?.url ||
                item.snippet?.thumbnails?.default?.url || '',
            url: item.id?.videoId
                ? `https://www.youtube.com/watch?v=${item.id.videoId}`
                : '',
        })).filter(v => v.videoId);
        return { results };
    } catch (e) {
        return { error: 'YouTube search failed.' };
    }
}

async function execYoutubeTranscript({ videoId }) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(String(videoId || ''))) {
        return { error: 'Invalid videoId.' };
    }
    try {
        const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
        if (!segments || !segments.length) {
            return { error: 'No captions available for this video. Ask the student what they saw and work from that.' };
        }
        let transcript = segments.map(s => s.text).join(' ');
        if (transcript.length > 30000) transcript = transcript.slice(0, 30000) + '… [truncated]';
        return { transcript };
    } catch (e) {
        return { error: 'Could not fetch captions for this video. Ask the student what they saw and work from that.' };
    }
}

async function execAddResource(store, studentId, state, input) {
    if (state.resources.length >= SHELF_CAP) {
        return { error: 'The shelf is full. Tell the student to remove something first.' };
    }
    const kind = String(input.kind || '').toLowerCase();
    if (!['web', 'youtube', 'note'].includes(kind)) {
        return { error: 'kind must be web, youtube, or note.' };
    }
    const title = String(input.title || '').trim().slice(0, 140);
    const description = String(input.description || '').trim().slice(0, 280);
    if (!title || !description) return { error: 'title and description are required.' };

    let url = String(input.url || '').trim();
    if (kind === 'web' || kind === 'youtube') {
        try {
            const parsed = new URL(url);
            // Reject javascript:, data:, file:, etc. — only http(s) goes on
            // the shelf because the URL renders as <a href> on the client.
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return { error: 'Only http(s) URLs are allowed.' };
            }
        } catch (e) {
            return { error: 'A valid URL is required.' };
        }
    }
    if (kind === 'youtube' && !/^[a-zA-Z0-9_-]{11}$/.test(String(input.videoId || ''))) {
        return { error: 'A valid videoId is required for YouTube resources.' };
    }

    const resource = {
        id: crypto.randomBytes(6).toString('hex'),
        kind,
        title,
        description,
        url: url || undefined,
        videoId: kind === 'youtube' ? input.videoId : undefined,
        thumbnail: input.thumbnail ? String(input.thumbnail).slice(0, 500) : undefined,
        addedBy: 'agent',
        addedAt: Date.now(),
    };
    state.resources.push(resource);
    await saveStudentState(store, studentId, state);
    return { ok: true, resource };
}

async function execSetWorkingQuestion(store, studentId, state, input) {
    const q = String(input.question || '').trim().slice(0, 500);
    if (!q) return { error: 'A question is required.' };
    state.workingQuestion = q;
    await saveStudentState(store, studentId, state);
    return { ok: true, workingQuestion: q };
}

async function execUpdateProgressNotes(store, studentId, state, input) {
    const notes = String(input.notes || '').trim().slice(0, 500);
    if (!notes) return { error: 'Notes content is required.' };
    state.progressNotes = notes;
    await saveStudentState(store, studentId, state);
    return { ok: true, progressNotes: notes };
}

async function dispatchTool(name, input, ctx) {
    if (ctx.anonymous && (name === 'add_resource' || name === 'set_working_question' || name === 'update_progress_notes')) {
        return { error: 'This tool is only available when the student is signed in.' };
    }
    switch (name) {
        case 'youtube_search':
            return execYoutubeSearch(input);
        case 'youtube_transcript':
            return execYoutubeTranscript(input);
        case 'add_resource':
            return execAddResource(ctx.store, ctx.studentId, ctx.state, input);
        case 'set_working_question':
            return execSetWorkingQuestion(ctx.store, ctx.studentId, ctx.state, input);
        case 'update_progress_notes':
            return execUpdateProgressNotes(ctx.store, ctx.studentId, ctx.state, input);
        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function stripEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function checkRateLimit(ip) {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const recent = (rateBuckets.get(ip) || []).filter(t => t > cutoff);
    if (recent.length >= RATE_LIMIT_MAX) {
        const retryAfterMs = recent[0] + RATE_LIMIT_WINDOW_MS - now;
        return { ok: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    rateBuckets.set(ip, recent);
    // Opportunistic cleanup: every ~50th call, evict empty buckets so the
    // Map does not grow unboundedly across a warm container's lifetime.
    if (rateBuckets.size > 100 && Math.random() < 0.02) {
        for (const [k, v] of rateBuckets) {
            if (v.filter(t => t > cutoff).length === 0) rateBuckets.delete(k);
        }
    }
    return { ok: true };
}

function getIp(event) {
    const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
    if (xff) return String(xff).split(',')[0].trim();
    return event.headers?.['client-ip'] || 'unknown';
}

function buildSystem(student, state) {
    // Layout the system blocks so the cache breakpoint sits on the LARGE,
    // SLOW-CHANGING readings block. The student-context block comes AFTER
    // the breakpoint -- uncached, small, freshly rebuilt on every turn
    // with the latest working question, shelf, and progress notes.
    //
    // Without this discipline, any state change (a resource added, a
    // working-question edit, the agent updating its progress notes) would
    // invalidate the 103K-token readings cache and force a fresh write at
    // 1.25x input rate. With it, the readings stay cached for the 5-min
    // ephemeral TTL and only the small student-context block is recharged.
    const blocks = [{ type: 'text', text: SOCRATIC_SYSTEM_PROMPT }];

    const packs = loadAllPacks();
    if (packs && packs.length > 4000) {
        blocks.push({
            type: 'text',
            text:
                '\n\n--- CACHED READINGS ---\n' +
                'The following passages are available as primary-source material. Quote them ' +
                'when pointing the student toward a specific argument. Always pair a quote with ' +
                'a one-sentence plain-language version when the language is hard.\n' +
                packs,
            cache_control: { type: 'ephemeral' },  // <-- CACHE BREAKPOINT HERE
        });
    } else {
        // No readings -> cache breakpoint goes on the Socratic prompt block
        blocks[0].cache_control = { type: 'ephemeral' };
    }

    // ---- Per-turn student context (UNCACHED, fresh every call) ----
    if (student) {
        const lines = [
            `--- THIS STUDENT (refreshed each turn) ---`,
            `First name: ${student.firstName}`,
            ``,
            `Working question:`,
            `  ${state.workingQuestion || '(not set yet — help them find one)'}`,
            ``,
        ];
        if (state.progressNotes) {
            lines.push(`Your last progress notes about where they are up to and how they are approaching it:`);
            lines.push(`  ${state.progressNotes}`);
            lines.push(``);
            lines.push(`Use these notes to pick up where you left off. Update them with update_progress_notes when their thinking shifts.`);
        } else {
            lines.push(`No progress notes yet. After this turn, call update_progress_notes with a short snapshot of where they are.`);
        }
        lines.push(``);
        if (state.resources.length) {
            lines.push(`Their resource shelf (${state.resources.length} item${state.resources.length === 1 ? '' : 's'}):`);
            for (const r of state.resources) {
                lines.push(`  - [${r.kind}] ${r.title} (${r.addedBy})`);
            }
        } else {
            lines.push(`Their resource shelf is empty.`);
        }
        blocks.push({ type: 'text', text: lines.join('\n') });
    } else {
        blocks.push({
            type: 'text',
            text: '--- ANONYMOUS CHAMBER VISIT ---\nThis student is browsing without signing in. You cannot save resources, update their working question, or maintain progress notes. Help them think, point them at readings if relevant, and suggest they sign in if they want their work to follow them.',
        });
    }

    return blocks;
}

function buildHistory(history, currentMessage) {
    const truncated = Array.isArray(history) ? history.slice(-HISTORY_TURN_LIMIT * 2) : [];
    const out = truncated.map(m => ({
        role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
        // Coalesce empty-string content correctly (the || form skips '' which
        // falls through to undefined — sending an empty user message to the
        // API breaks the tool-use loop)
        content: (m.content != null ? m.content : (m.text != null ? m.text : '')),
    }));
    out.push({ role: 'user', content: String(currentMessage || '') });
    return out;
}

function extractText(response) {
    return (response.content || [])
        .filter(b => b && b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
}

// ----------------------------------------------------------------------
// Agentic loop
// ----------------------------------------------------------------------

async function runAgent({ system, messages, ctx, ip }) {
    const client = getClient();
    const resourcesAdded = [];
    let workingQuestionSet = null;
    let lastResponse = null;

    // Anonymous (chamber.html) mode: drop state-mutating tools.
    const activeTools = ctx.anonymous
        ? TOOLS.filter(t => t.name === 'youtube_search' || t.name === 'youtube_transcript')
        : TOOLS;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            tools: activeTools,
            messages,
        });
        lastResponse = response;

        const usage = response.usage || {};
        console.log(JSON.stringify({
            event: 'chat.usage',
            ip,
            studentId: ctx.studentId,
            loop,
            stop_reason: response.stop_reason,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
        }));

        if (response.stop_reason !== 'tool_use') break;

        // Execute tools and feed results back
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            const result = await dispatchTool(block.name, block.input, ctx);
            if (block.name === 'add_resource' && result.ok && result.resource) {
                resourcesAdded.push(result.resource);
            }
            if (block.name === 'set_working_question' && result.ok) {
                workingQuestionSet = result.workingQuestion;
            }
            toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
            });
        }
        messages.push({ role: 'user', content: toolResults });
    }

    // If we exited the loop while still asking for tool use, the agent
    // hit MAX_TOOL_LOOPS without producing a text reply. Give the student
    // a human-readable fallback instead of "(no reply)".
    let text = lastResponse ? extractText(lastResponse) : '';
    if (!text && lastResponse && lastResponse.stop_reason === 'tool_use') {
        text = 'I went down a research rabbit hole and ran out of steps for this turn. Ask me something more focused, or tell me which lead to follow first.';
        console.warn(JSON.stringify({
            event: 'chat.max_tool_loops_reached',
            studentId: ctx.studentId,
        }));
    }
    if (!text) text = '(The agent paused. Try rephrasing.)';

    return {
        text,
        resourcesAdded,
        workingQuestionSet,
    };
}

// ----------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
};

function respond(statusCode, body) {
    return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event, netlifyContext) => {
    // Lambda-compat mode bridge for @netlify/blobs. The SDK reads the blob
    // context from event.blobs (a base64-encoded {url, token, siteID} blob),
    // NOT from the function's context arg. Per the SDK README's Lambda
    // compatibility section, connectLambda must be passed the Lambda EVENT.
    try { connectLambda(event); } catch (e) {
        // Only logs in genuine misconfiguration; absent context in netlify-dev
        // is fine because getStore() falls through to env-based config there.
        console.warn('connectLambda(event) skipped:', e.message);
    }

    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    const ip = getIp(event);
    const lim = checkRateLimit(ip);
    if (!lim.ok) return respond(429, { error: `Slow down — try again in ${lim.retryAfter}s.` });

    // Token is optional: with a token, the agent runs in per-student "portal
    // mode" with tools that mutate the student's shelf and working question.
    // Without a token (anonymous chamber.html visits), the agent runs in
    // read-only "chamber mode": search/transcript tools work, state-mutating
    // tools are dropped, and the system prompt skips the student context block.
    const studentId = authenticate(event);
    const student = studentId ? getStudent(studentId) : null;
    if (studentId && !student) return respond(401, { error: 'Student not found.' });

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return respond(400, { error: 'Invalid JSON' });
    }
    // Accept either {message, history} (portal) or {messages: [{role,text},...]} (legacy chamber)
    let message = payload.message;
    let history = payload.history;
    if (!message && Array.isArray(payload.messages) && payload.messages.length) {
        const lastUser = [...payload.messages].reverse().find(m => m.role === 'user');
        message = lastUser ? (lastUser.text || lastUser.content) : '';
        history = payload.messages.slice(0, -1);
    }
    if (typeof message !== 'string' || !message.trim()) {
        return respond(400, { error: 'message required' });
    }

    try {
        let store = null;
        let state = { workingQuestion: '', resources: [], chatHistory: [], progressNotes: '' };
        if (student) {
            store = studentStore(netlifyContext);
            state = await loadStudentState(store, studentId);
        }
        const system = buildSystem(student, state);

        // Build the messages array from PERSISTED chatHistory (preferred when
        // signed in) rather than the client-sent history. This guarantees the
        // server has the canonical record even if the client dropped state
        // (e.g. tab reload mid-session). Falls back to client-sent history
        // for anonymous mode.
        const historyForAgent = student && state.chatHistory && state.chatHistory.length
            ? state.chatHistory
            : history;
        const messages = buildHistory(historyForAgent, message);

        const result = await runAgent({
            system,
            messages,
            ctx: { store, studentId, state, anonymous: !student },
            ip,
        });

        const reply = result.text || '(The agent paused. Try rephrasing.)';

        // Persist updated chat history (signed-in students only). Cap at 40
        // turns (20 user + 20 assistant) so the Blob stays bounded. The
        // agent's tool-use back-and-forth is not stored — only the user-
        // facing turns, so the next session's replay stays clean.
        if (student && store) {
            const newHistory = Array.isArray(state.chatHistory) ? state.chatHistory.slice() : [];
            newHistory.push({ role: 'user', content: message, ts: Date.now() });
            newHistory.push({ role: 'assistant', content: reply, ts: Date.now() });
            state.chatHistory = newHistory.slice(-40);
            try {
                await saveStudentState(store, studentId, state);
            } catch (e) {
                console.error('chat: failed to persist chatHistory', e);
                // Non-fatal — reply still returns
            }
        }

        const body = { reply };
        if (result.resourcesAdded.length) body.resources_added = result.resourcesAdded;
        if (result.workingQuestionSet !== null) body.working_question_set = result.workingQuestionSet;
        return respond(200, body);
    } catch (err) {
        console.error('chat function error:', err && err.stack || err);
        const status = (err && typeof err.status === 'number' && err.status >= 400 && err.status < 600)
            ? err.status : 500;
        return respond(status, { error: err.message || 'Internal error' });
    }
};
