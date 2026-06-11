/**
 * chat.js -- Marginalia Stage 1 Issues Study: per-student Socratic agent.
 *
 * POST /.netlify/functions/chat
 * Body: { token, message, history }   (portal mode)
 *    or { messages: [{role,text}...], pack }   (legacy chamber mode)
 * Returns: { reply, resources_added?, working_question_set? }
 *
 * Wire pattern: direct fetch to OpenRouter's OpenAI-compatible
 * /chat/completions endpoint. NOT the @anthropic-ai/sdk -- it has known
 * cache_control propagation bugs against OpenRouter and produced
 * "Connection error" with no diagnostic in production.
 *
 * Routing: anthropic/claude-haiku-4.5, provider-pinned to Anthropic-only,
 * no fallbacks -- cache pool integrity.
 *
 * Tools (OpenAI tool-use format): youtube_search, youtube_transcript,
 * add_resource, set_working_question, update_progress_notes. Tool-use loop
 * runs up to MAX_TOOL_LOOPS iterations per chat turn.
 *
 * Per-student state: Netlify Blobs, store "marginalia-students" configured
 * with explicit siteID + token (NETLIFY_BLOBS_TOKEN) -- legacy V1 functions
 * must set these manually. State key students/<id>/state.json
 * holds workingQuestion, resources, chatHistory (last 40), progressNotes.
 *
 * Cached readings: all 6 Stage 1 packs concatenated, attached to the system
 * message as a single cache_control breakpoint with ttl:"1h". Below 4096
 * tokens the cache marker is dropped (silent no-op + wastes a breakpoint).
 *
 * Env vars: OPENROUTER_API_KEY, YOUTUBE_API_KEY, SESSION_SECRET.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { YoutubeTranscript } = require('youtube-transcript');

const { authenticate } = require('./_lib/session');
const { getStudent } = require('./_lib/registry');
const { corsHeaders, ALLOWED_ORIGINS } = require('./_lib/cors');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_OUTPUT_TOKENS = 800;
const HISTORY_TURN_LIMIT = 6;
const MAX_TOOL_LOOPS = 6;
const HAIKU_CACHE_MIN_TOKENS = 4096;
// Keyed per student when signed in, else per IP. Set generously: anonymous use
// (chamber + task explainer) shares one bucket across the whole class behind the
// school NAT, so a low cap would throttle the lesson. The OpenRouter spend cap is
// the real backstop against runaway cost.
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const SHELF_CAP = 30;

const PROVIDER_PIN = {
    only: ['anthropic'],
    allow_fallbacks: false,
};

// ----------------------------------------------------------------------
// Socratic system prompt (unchanged from prior version, just smaller copy
// of the doc here for clarity)
// ----------------------------------------------------------------------

const SOCRATIC_SYSTEM_PROMPT = `You are the agent — a Socratic interlocutor for a Year 11 student doing the SACE Stage 1 Philosophy Issues Study (Assessment Type 3).

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

YOUR VOICE
You are warm, curious, and genuinely interested — a thinking partner who finds these questions exciting, not a marker ticking boxes. Talk like a sharp, friendly tutor, not a textbook. A little wit is welcome; pomposity is not. When a student is stuck or anxious, be encouraging about their THINKING, never about mere effort ("that distinction is doing real work" — not "great job!"). Reward curiosity: if a student chases an interesting tangent or asks a bold question, follow them into it for a beat before steering back. A vivid example or a quick thought experiment is often worth more than an explanation — reach for one when an idea won't land. You can point them to the Thought-Experiment Lab on this site (the trolley problem, the experience machine, Mary's room) when a classic puzzle would sharpen their question.

WHEN TO USE YOUR TOOLS
You have five tools. Use them sparingly and only when they help.

- youtube_search: Use when the student needs an entry point — a thinker they have not met, a position they cannot name, a debate they are gesturing at. Search returns up to 5 videos. Pick the best one or two and add them to the shelf using add_resource.
- youtube_transcript: Use AFTER the student has watched a video they named. Read the transcript so you can ask them what they took from it. Do not read it before — that ruins the watch.
- add_resource: Use when you have found something the student should keep. Always say in your reply what you added and why, in plain words. Keep the title ≤140 characters. Keep the description ≤280 characters and at Year 11 reading level.
- set_working_question: Use ONLY when the student has explicitly committed to a refined version of their question. Confirm in your next reply.
- update_progress_notes: After any meaningful shift in the student's thinking — a position they are now taking seriously, a reading they have processed, a refined question — save a short snapshot (≤500 chars) of where they are up to and how they are approaching the problem. These notes feed back into your context on every future turn, so future-you can pick up where past-you left off. Update them as a snapshot (replaces previous), not a log (do not accumulate).

PLAIN-LANGUAGE RULES — WHEN YOU EXPLAIN HARD IDEAS
The cached readings below are academic philosophy. They are written for adults. The student reads at about Year 8 level when tired or anxious.

If the student asks you to explain a passage, or asks "what does that mean?", or clicks "Explain plainly":
- Sentences average around 14 words. Never longer than 25.
- Active voice. Use "you" or the thinker's name as the subject — not "one" or "it is the case that".
- Define any hard word on first use, inline, in parentheses: "a *veil* (a thin cover that hides what's behind it)".
- Use the same word for the same concept throughout. Do not switch between "the unconscious", "below awareness", and "the hidden mind".
- Give a concrete example or scene when it helps.
- Keep the philosophical move intact. Plain language is not dumbing down.

WHEN YOU QUOTE A READING
- Quote at most three short sentences at a time.
- After the quote, name the move ("She is saying that…") in one sentence.
- Then ask a question. Do not pre-explain unprompted.

HOW YOU ASK QUESTIONS
- One question per turn. Then stop.
- When the student gives a topic, press: "What about that catches your attention?"
- When the student gives a position, ask: "What is the strongest objection?"
- When the student wants to know what a philosopher thinks, point them at a reading or video — do not summarise unprompted.
- Use philosophical terminology accurately. If the student gestures at a concept without knowing the word, name it once: "There's a word for that. Sartre calls it *bad faith*."
- Register thinking, not effort: "That's a sharper formulation." Avoid generic praise ("great question!", "well done!").

LIMITS
- 2–4 sentences per turn, unless you are reporting back on a tool call.
- Never write paragraphs of philosophy for the student.
- Never write any portion of the essay.
- If the student asks you to write it: "That would do the thinking the assessment is asking you to do. Let me ask a question that might help instead…"

The student's identity, working question, progress notes, and current resource shelf appear in the context block before their first message. Use them.`;

// ----------------------------------------------------------------------
// Task Explainer system prompt — used by the shared "Explain the task"
// agent (mode:'explain'). Anonymous; grounded in the cached
// tasksheet_explainer pack. UNLIKE the Socratic agent this one DOES
// explain the task clearly; it still never writes any part of the essay.
// ----------------------------------------------------------------------

const EXPLAINER_SYSTEM_PROMPT = `You are the Task Explainer for the SACE Stage 1 Philosophy "Issues Study" (Assessment Type 3). A Year 11 student has clicked "Explain the task". Your one job is to make every element of the task sheet clear.

Be warm and plain-spoken. This task makes students nervous because it is open-ended, so your tone should make it feel doable, even inviting — encouraging without being gushing. You are the friendly teacher who demystifies the rubric, not the rubric itself.

WHAT YOU DO
- Explain any part of the task sheet: choosing a philosophical question, the "more than one position" requirement, critical analysis, justifying with evidence, referencing, the word count and due dates, the format options, and the four criteria (Knowledge & Understanding, Reasoning, Critical Analysis, Communication).
- Explain what separates an A from a C, using the grade descriptions and the A-grade and C-grade exemplars in the cached materials below.
- Ground every answer in the cached materials. Quote them or point to them. They are authoritative.
- Use plain Year-11 language. Sentences average about 14 words; never over 25. Define any hard word on first use, in parentheses. Australian spelling.
- Keep answers short — 2 to 5 sentences — unless the student asks for a step-by-step walk-through. End by offering one concrete next step.

WHAT YOU DO NOT DO
- You do not write, draft, outline, or rephrase any part of a student's essay.
- You do not choose the student's issue, question, or position for them.
- You do not invent requirements, dates, or facts that are not in the cached materials. If something is not covered, say: "The task sheet doesn't specify that — check with your teacher."
- You do not discuss anything unrelated to the Issues Study. Redirect politely.

If a student asks "what should I write" or "give me an example for my topic", explain the relevant requirement, then point them to the Socratic chamber (to sharpen their own question) and the drafting scaffold (to structure it). Do not produce essay content yourself.`;

// ----------------------------------------------------------------------
// Curator system prompt — used by the Showroom "exhibition guide"
// (mode:'exemplars'). Anonymous; grounded in the cached exemplars_corpus
// pack. It shows students HOW others did the Issues Study and drives a
// client-side exhibit panel via the show_exhibit tool. Never writes a study.
// ----------------------------------------------------------------------

const CURATOR_SYSTEM_PROMPT = `You are the Curator of the Issues Study Showroom — a warm, curious exhibition guide for a Year 11 SACE Stage 1 Philosophy student. The Showroom is a gallery of finished Issues Studies done in many different forms. Your job: show the student HOW others approached the task, so they can find their own way in.

YOUR VOICE
- Warm, a little witty, genuinely delighted by these examples — a gallery guide who loves the collection, not a marker.
- Plain Year-11 language. Sentences average about 14 words; never over 25. Define any hard word on first use, in parentheses. Australian spelling.
- Short turns: 2 to 4 sentences, unless walking through one exemplar step by step.

WHAT YOU DO
- Answer questions about the exemplars in the cached corpus below: how each one chose its question, researched its philosophers, structured its argument, and which form it used.
- When an exemplar (or thinker) is relevant, CALL show_exhibit with its exact exhibit id, and a short highlight phrase taken VERBATIM from that exhibit's text, so it appears in the panel beside you with the phrase highlighted. Then say in plain words what to notice about it.
- Help a student see which FORM might suit them, and which THINKER fits their question.
- Always ground answers in the corpus. If something is not in it, say so plainly.

WHAT YOU DO NOT DO
- You do not write, draft, outline, or rephrase any part of the student's own essay, poster, script, or study.
- You do not choose the student's question or position for them. If asked "what should I do mine on?", turn it back: show how others chose, then ask what pulls at them.
- You do not invent exemplars, quotes, or facts beyond the corpus.

HOW TO USE show_exhibit
- Call it whenever you reference a specific exhibit — the student should SEE what you describe.
- exhibit_id must be one of the ids in the corpus (e.g. parable-freewill, poster-mind, dialogue-knowledge, essay-euthanasia, film-meaning, slides-religion, letter-speech).
- highlight must be a short phrase copied exactly from that exhibit's text (use the HIGHLIGHTABLE phrases). Keep it under ~8 words so it matches.
- You may call it more than once if comparing two exhibits.

If a student tries to get you to write their study: "That's the bit the assessment wants from YOU. But let me show you how someone else got started…" then show an exhibit.`;

// ----------------------------------------------------------------------
// Tool definitions (OpenAI tool-use format — function calling)
// ----------------------------------------------------------------------

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'youtube_search',
            description:
                'Search YouTube for educational videos on a philosophical topic, thinker, or argument. Returns up to 5 videos with title, description, thumbnail, videoId. Use sparingly — only when the student needs an entry point they do not have.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query. Be specific.' },
                    max_results: { type: 'integer', description: 'Up to 5. Default 5.', default: 5 },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'youtube_transcript',
            description:
                'Fetch the transcript of a YouTube video the student has watched. Use only AFTER the student names a video they watched.',
            parameters: {
                type: 'object',
                properties: {
                    videoId: { type: 'string', description: 'The 11-character YouTube video id.' },
                },
                required: ['videoId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_resource',
            description:
                'Add a resource (web link or YouTube video) to the student\'s shelf. Always tell the student in your reply what you added and why.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['web', 'youtube', 'note'] },
                    title: { type: 'string', description: '≤140 chars.' },
                    url: { type: 'string', description: 'Full http(s) URL.' },
                    description: { type: 'string', description: 'Why this helps, ≤280 chars, plain Year-11 language.' },
                    videoId: { type: 'string', description: 'YouTube videoId (required if kind=youtube).' },
                    thumbnail: { type: 'string', description: 'Thumbnail URL (optional).' },
                },
                required: ['kind', 'title', 'description'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_working_question',
            description:
                'Update the student\'s saved working question. Use ONLY when the student has explicitly committed.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: '≤500 chars.' },
                },
                required: ['question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_progress_notes',
            description:
                'Save a short running summary (snapshot, replaces previous; ≤500 chars) of where this student is up to, what their current question is, and how they are approaching it. Feeds back into your context on every future turn.',
            parameters: {
                type: 'object',
                properties: {
                    notes: { type: 'string', description: 'Snapshot, ≤500 chars.' },
                },
                required: ['notes'],
            },
        },
    },
];

// Curator's single tool: drive the client-side exhibit panel. It mutates no
// server state, so it is safe in the anonymous Curator mode.
const CURATOR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'show_exhibit',
            description:
                'Bring an exemplar up in the panel beside the student and highlight a phrase in it. Call whenever you reference a specific exhibit so the student SEES it.',
            parameters: {
                type: 'object',
                properties: {
                    exhibit_id: {
                        type: 'string',
                        description: 'Exact exhibit id from the corpus, e.g. parable-freewill, poster-mind, dialogue-knowledge, essay-euthanasia, film-meaning, slides-religion, letter-speech.',
                    },
                    highlight: {
                        type: 'string',
                        description: 'A short phrase (≤8 words) copied VERBATIM from that exhibit\'s text, to highlight in the panel.',
                    },
                },
                required: ['exhibit_id'],
            },
        },
    },
];

// Valid exhibit ids — guards the show_exhibit tool against hallucinated ids.
const VALID_EXHIBITS = new Set([
    'essay-euthanasia', 'parable-freewill', 'film-meaning', 'poster-mind',
    'dialogue-knowledge', 'slides-religion', 'letter-speech',
]);

// ----------------------------------------------------------------------
// Caches (per Lambda container; soft, fine at class scale)
// ----------------------------------------------------------------------

const packCache = new Map();   // packId -> text | null
const rateBuckets = new Map();

// Load a SINGLE pack on demand. The earlier "concatenate all 6" approach
// blew Haiku's 200K context (the packs total ~180K tokens together once
// main's added Ned Block / second-pass enrichments are factored in).
// Pack passes as `pack` in the request body — chamber.html topic chips
// already supply it; portal.html can pass it once topic-detection is added.
function loadPackText(packId) {
    if (!packId || packId === 'auto') return null;
    if (!/^[a-z0-9_]+$/i.test(packId)) return null;  // path-traversal guard
    if (packCache.has(packId)) return packCache.get(packId);
    const file = path.join(__dirname, '..', '..', 'data', 'packs', `${packId}.txt`);
    try {
        const text = fs.readFileSync(file, 'utf8');
        packCache.set(packId, text);
        return text;
    } catch (e) {
        packCache.set(packId, null);
        if (e.code !== 'ENOENT') {
            console.error('loadPackText: read failed', packId, e.message);
        }
        return null;
    }
}

function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}

// ----------------------------------------------------------------------
// API headers
// ----------------------------------------------------------------------

function getApiKey() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY env var is not set.');
    }
    return apiKey;
}

function getHeaders() {
    return {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        // Canonical header names per OpenRouter docs.
        'HTTP-Referer': 'https://marginalia-issues-study.netlify.app',
        'X-OpenRouter-Title': 'Marginalia - Stage 1 Issues Study',
    };
}

// ----------------------------------------------------------------------
// Rate limit
// ----------------------------------------------------------------------

function getClientIp(event) {
    const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
    if (xff) return String(xff).split(',')[0].trim();
    return event.headers?.['client-ip'] || 'unknown';
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
    if (rateBuckets.size > 100 && Math.random() < 0.02) {
        for (const [k, v] of rateBuckets) {
            if (v.filter(t => t > cutoff).length === 0) rateBuckets.delete(k);
        }
    }
    return { ok: true };
}

// ----------------------------------------------------------------------
// Per-student state (Netlify Blobs, edge access)
// ----------------------------------------------------------------------

// Legacy V1 Netlify Functions no longer receive an injected `event.blobs`
// payload, so connectLambda() can't wire Blobs credentials and getStore()
// throws "environment has not been configured". Per Netlify's guidance, V1
// functions must configure the store manually with siteID + token.
const BLOBS_SITE_ID = process.env.BLOBS_SITE_ID || 'ce8fd3dc-cfdf-4859-80dc-7f0803591109';
const BLOBS_TOKEN = process.env.NETLIFY_BLOBS_TOKEN || '';

function studentStore() {
    return getStore({ name: 'marginalia-students', siteID: BLOBS_SITE_ID, token: BLOBS_TOKEN });
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

function stripEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

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
    try {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return { error: `YouTube returned ${r.status}.` };
        const data = await r.json();
        const results = (data.items || []).map(item => ({
            videoId: item.id?.videoId,
            title: stripEntities(item.snippet?.title || ''),
            description: stripEntities((item.snippet?.description || '').slice(0, 280)),
            channelTitle: item.snippet?.channelTitle || '',
            thumbnail:
                item.snippet?.thumbnails?.high?.url ||
                item.snippet?.thumbnails?.medium?.url ||
                item.snippet?.thumbnails?.default?.url || '',
            url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
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
            return { error: 'No captions available. Ask the student what they saw.' };
        }
        let transcript = segments.map(s => s.text).join(' ');
        if (transcript.length > 30000) transcript = transcript.slice(0, 30000) + '… [truncated]';
        return { transcript };
    } catch (e) {
        return { error: 'Could not fetch captions. Ask the student what they saw.' };
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
        case 'youtube_search': return execYoutubeSearch(input);
        case 'youtube_transcript': return execYoutubeTranscript(input);
        case 'add_resource': return execAddResource(ctx.store, ctx.studentId, ctx.state, input);
        case 'set_working_question': return execSetWorkingQuestion(ctx.store, ctx.studentId, ctx.state, input);
        case 'update_progress_notes': return execUpdateProgressNotes(ctx.store, ctx.studentId, ctx.state, input);
        default: return { error: `Unknown tool: ${name}` };
    }
}

// ----------------------------------------------------------------------
// Message builders
// ----------------------------------------------------------------------

function buildSystemMessage(student, state, packId) {
    // Block 1: stable Socratic prompt
    const blocks = [{ type: 'text', text: SOCRATIC_SYSTEM_PROMPT }];

    // Block 2: a SINGLE topic-relevant readings pack, if one was specified.
    // Loading all 6 would exceed Haiku's 200K window. Default behaviour
    // (no pack) lets the agent reason from training-data knowledge of the
    // canonical texts.
    const packText = loadPackText(packId);
    if (packText && packText.length > 4000) {
        const text =
            '\n\n--- READINGS FOR THIS TOPIC ---\n' +
            'Quote these primary sources when pointing the student to a specific argument. Do not summarise unprompted.\n' +
            packText;
        const block = { type: 'text', text };
        if (approxTokens(SOCRATIC_SYSTEM_PROMPT) + approxTokens(text) >= HAIKU_CACHE_MIN_TOKENS) {
            // 1h TTL — student think-time often exceeds 5min between turns.
            block.cache_control = { type: 'ephemeral', ttl: '1h' };
        }
        blocks.push(block);
    }

    // Block 3: per-turn student context (UNCACHED — fresh every turn so the
    // agent always sees the latest working question / shelf / progress notes)
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
            lines.push(`Your last progress notes about where they are up to:`);
            lines.push(`  ${state.progressNotes}`);
            lines.push(``);
            lines.push(`Update them with update_progress_notes when their thinking shifts.`);
        } else {
            lines.push(`No progress notes yet. After this turn, call update_progress_notes with a short snapshot.`);
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
            text: '--- ANONYMOUS CHAMBER VISIT ---\nThis student is browsing without signing in. You cannot save resources, working question, or progress notes. Suggest they sign in if they want their work to follow them.',
        });
    }

    return { role: 'system', content: blocks };
}

function buildExplainerSystemMessage() {
    // Block 1: stable explainer instructions.
    const blocks = [{ type: 'text', text: EXPLAINER_SYSTEM_PROMPT }];
    // Block 2: the cached tasksheet + criteria + grade descriptions + A/C
    // exemplars (the "choice cuts"). Bundled together so the stable prefix
    // clears Haiku's 4096-token cache minimum — the task sheet alone would
    // not — giving a 1h-TTL cache hit across the class's questions.
    const packText = loadPackText('tasksheet_explainer');
    if (packText && packText.length > 2000) {
        const text =
            '\n\n--- THE TASK SHEET, CRITERIA, GRADE DESCRIPTIONS & A/C EXEMPLARS ---\n' +
            'These are authoritative. Ground every answer in them; quote or point to them. Do not invent requirements not stated here.\n' +
            packText;
        const block = { type: 'text', text };
        if (approxTokens(EXPLAINER_SYSTEM_PROMPT) + approxTokens(text) >= HAIKU_CACHE_MIN_TOKENS) {
            block.cache_control = { type: 'ephemeral', ttl: '1h' };
        }
        blocks.push(block);
    }
    return { role: 'system', content: blocks };
}

function buildCuratorSystemMessage() {
    // Block 1: stable Curator instructions.
    const blocks = [{ type: 'text', text: CURATOR_SYSTEM_PROMPT }];
    // Block 2: the cached exemplar corpus (every exhibit + thinker). Cached at
    // 1h TTL so the whole class shares one warm prefix — the cost defence that
    // makes this cheap (one write ~$0.04/h; each turn is a cache read).
    const packText = loadPackText('exemplars_corpus');
    if (packText && packText.length > 2000) {
        const text =
            '\n\n--- THE SHOWROOM EXEMPLAR CORPUS (authoritative) ---\n' +
            'Ground every answer in this. Use the exact exhibit ids with show_exhibit. Do not invent exemplars.\n' +
            packText;
        const block = { type: 'text', text };
        if (approxTokens(CURATOR_SYSTEM_PROMPT) + approxTokens(text) >= HAIKU_CACHE_MIN_TOKENS) {
            block.cache_control = { type: 'ephemeral', ttl: '1h' };
        }
        blocks.push(block);
    }
    return { role: 'system', content: blocks };
}

function buildConversationMessages(history, currentMessage) {
    const truncated = Array.isArray(history) ? history.slice(-HISTORY_TURN_LIMIT * 2) : [];
    const out = truncated.map(m => ({
        role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
        content: (m.content != null ? m.content : (m.text != null ? m.text : '')),
    }));
    out.push({ role: 'user', content: String(currentMessage || '') });
    return out;
}

// ----------------------------------------------------------------------
// OpenRouter call (with retry on 408/429/503)
// ----------------------------------------------------------------------

async function callOpenRouter(body, attempt = 0) {
    const maxAttempts = 3;
    let response;
    try {
        response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(45_000),
        });
    } catch (err) {
        if (attempt < 1) {
            await new Promise(r => setTimeout(r, 1000));
            return callOpenRouter(body, attempt + 1);
        }
        throw err;
    }

    const retryable = [408, 429, 503];
    if (retryable.includes(response.status) && attempt < maxAttempts - 1) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
        const backoffMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, backoffMs));
        return callOpenRouter(body, attempt + 1);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = response.status;
        const message = data?.error?.message || `HTTP ${code}`;
        const error = new Error(`OpenRouter ${code}: ${message}`);
        error.status = code;
        error.metadata = data?.error?.metadata || null;
        throw error;
    }
    return data;
}

function logUsage(data, ip, studentId, loop, finishReason) {
    const u = data?.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    const cacheWrite = u.prompt_tokens_details?.cache_write_tokens || 0;
    console.log(JSON.stringify({
        event: 'chat.usage',
        ip,
        studentId,
        loop,
        finish_reason: finishReason,
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        cached_tokens: cached,
        cache_write_tokens: cacheWrite,
        cost: u.cost || 0,
        cache_ratio: cacheWrite > 0 ? Number((cached / cacheWrite).toFixed(2)) : null,
    }));
}

// ----------------------------------------------------------------------
// Agentic tool-use loop (OpenAI format)
// ----------------------------------------------------------------------

async function runAgent({ systemMessage, conversation, ctx, ip }) {
    const messages = [systemMessage, ...conversation];
    const resourcesAdded = [];
    let workingQuestionSet = null;

    // Strip tools that mutate state in anonymous mode.
    const activeTools = ctx.anonymous
        ? TOOLS.filter(t => t.function.name === 'youtube_search' || t.function.name === 'youtube_transcript')
        : TOOLS;

    let lastChoice = null;
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const body = {
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages,
            tools: activeTools,
            tool_choice: 'auto',
            provider: PROVIDER_PIN,
            ...(ctx.studentId ? { user: ctx.studentId } : {}),
        };
        const data = await callOpenRouter(body);
        const choice = data.choices?.[0];
        if (!choice) break;
        lastChoice = choice;
        logUsage(data, ip, ctx.studentId, loop, choice.finish_reason);

        if (choice.finish_reason === 'tool_calls' && Array.isArray(choice.message?.tool_calls)) {
            // Push the assistant message (with tool_calls) onto the convo
            messages.push(choice.message);
            // Execute each tool call and push results back
            for (const tc of choice.message.tool_calls) {
                const name = tc.function?.name;
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { /* leave empty */ }
                const result = await dispatchTool(name, args, ctx);
                if (name === 'add_resource' && result.ok && result.resource) {
                    resourcesAdded.push(result.resource);
                }
                if (name === 'set_working_question' && result.ok) {
                    workingQuestionSet = result.workingQuestion;
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result),
                });
            }
            continue;
        }
        // Any other finish_reason: stop, length, content_filter, etc.
        break;
    }

    let text = lastChoice?.message?.content || '';
    if (!text && lastChoice?.finish_reason === 'tool_calls') {
        text = 'I went down a research rabbit hole and ran out of steps for this turn. Ask me something more focused, or tell me which lead to follow first.';
        console.warn(JSON.stringify({
            event: 'chat.max_tool_loops_reached',
            studentId: ctx.studentId,
        }));
    }
    if (!text) text = '(The agent paused. Try rephrasing.)';

    return { text, resourcesAdded, workingQuestionSet };
}

// ----------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------

exports.handler = async (event, _ctx) => {
    const CORS = corsHeaders(event);
    const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    // Reject cross-site callers. CORS only chooses which Origin is reflected to a
    // browser; this is a real server-side gate so the AI endpoint can't be driven
    // from another page. A browser always sends Origin on these POSTs; a missing
    // Origin (same-origin / server-to-server) is allowed through.
    const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
    if (reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin)) {
        return respond(403, { error: 'Forbidden origin.' });
    }

    const ip = getClientIp(event);
    const studentId = authenticate(event);
    const student = studentId ? getStudent(studentId) : null;
    if (studentId && !student) return respond(401, { error: 'Student not found.' });

    // Every mode now requires a signed-in student. The explainer and curator
    // modes still keep their shared, stateless behaviour — this gate is about
    // not running an open AI endpoint, not about per-student state.
    if (!student) {
        return respond(401, { error: 'Please log in from the welcome page first — your session may have expired.' });
    }

    // Rate-limit per student so a shared school NAT does not make the whole
    // class share one bucket.
    const lim = checkRateLimit(studentId || ip);
    if (!lim.ok) return respond(429, { error: `Slow down — try again in ${lim.retryAfter}s.` });

    let payload;
    try { payload = JSON.parse(event.body || '{}'); } catch (e) {
        return respond(400, { error: 'Invalid JSON' });
    }

    // Task-explainer mode: shared + anonymous, no tools, no per-student state.
    // Grounded in the cached tasksheet_explainer pack. Triggered by the
    // "Explain the task" agent with { mode: 'explain', message, history }.
    if (payload.mode === 'explain') {
        let exMessage = payload.message;
        let exHistory = payload.history;
        if (!exMessage && Array.isArray(payload.messages) && payload.messages.length) {
            const lastUser = [...payload.messages].reverse().find(m => m.role === 'user');
            exMessage = lastUser ? (lastUser.text || lastUser.content) : '';
            exHistory = payload.messages.slice(0, -1);
        }
        if (typeof exMessage !== 'string' || !exMessage.trim()) {
            return respond(400, { error: 'message required' });
        }
        try {
            const systemMessage = buildExplainerSystemMessage();
            const conversation = buildConversationMessages(exHistory, exMessage);
            const data = await callOpenRouter({
                model: MODEL,
                max_tokens: MAX_OUTPUT_TOKENS,
                messages: [systemMessage, ...conversation],
                provider: PROVIDER_PIN,
            });
            const choice = data.choices?.[0];
            logUsage(data, ip, 'explainer', 0, choice?.finish_reason);
            const reply = (choice?.message?.content) ||
                '(The explainer paused. Try rephrasing your question about the task.)';
            return respond(200, { reply });
        } catch (err) {
            console.error('explain function error:', err && err.stack || err);
            const status = (err.status >= 400 && err.status < 600) ? err.status : 500;
            if (status === 402) {
                return respond(503, { error: 'The classroom AI is temporarily unavailable. Please tell your teacher.' });
            }
            return respond(status, { error: err.message || 'Internal error' });
        }
    }

    // Curator mode (the Showroom): shared + anonymous, no per-student state.
    // Grounded in the cached exemplars_corpus pack. Has ONE tool, show_exhibit,
    // which drives the client-side exhibit panel — collected and returned as
    // `exhibits` for the page to render. Triggered by { mode: 'exemplars',
    // message, history }.
    if (payload.mode === 'exemplars') {
        let cuMessage = payload.message;
        let cuHistory = payload.history;
        if (typeof cuMessage !== 'string' || !cuMessage.trim()) {
            return respond(400, { error: 'message required' });
        }
        try {
            const systemMessage = buildCuratorSystemMessage();
            const conversation = buildConversationMessages(cuHistory, cuMessage);
            const messages = [systemMessage, ...conversation];
            const exhibits = [];
            const exhibitIds = new Set();   // dedup — show each exhibit at most once
            let replyText = '';
            let lastFinish = null;
            let invalidStreak = 0;          // consecutive turns with only rejected tool calls

            for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
                const data = await callOpenRouter({
                    model: MODEL,
                    max_tokens: MAX_OUTPUT_TOKENS,
                    messages,
                    tools: CURATOR_TOOLS,
                    tool_choice: 'auto',
                    provider: PROVIDER_PIN,
                });
                const choice = data.choices?.[0];
                if (!choice) break;
                lastFinish = choice.finish_reason;
                logUsage(data, ip, 'curator', loop, choice.finish_reason);

                if (choice.finish_reason === 'tool_calls' && Array.isArray(choice.message?.tool_calls)) {
                    messages.push(choice.message);
                    let validThisLoop = 0;
                    // Cap tool calls handled per response so one message can't bloat the convo.
                    for (const tc of choice.message.tool_calls.slice(0, 4)) {
                        let args = {};
                        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { /* ignore */ }
                        let result;
                        if (tc.function?.name === 'show_exhibit' && VALID_EXHIBITS.has(args.exhibit_id)) {
                            validThisLoop++;
                            if (!exhibitIds.has(args.exhibit_id)) {
                                exhibitIds.add(args.exhibit_id);
                                const item = { id: args.exhibit_id };
                                if (typeof args.highlight === 'string' && args.highlight.trim()) {
                                    item.highlight = args.highlight.trim().slice(0, 120);
                                }
                                exhibits.push(item);
                            }
                            result = { ok: true, shown: args.exhibit_id };
                        } else {
                            result = { error: 'Unknown exhibit id. Use one from the corpus.' };
                        }
                        if (tc.id) {
                            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                        }
                    }
                    // Break out of repeated all-invalid tool churn (bounds worst-case spend).
                    invalidStreak = validThisLoop === 0 ? invalidStreak + 1 : 0;
                    if (invalidStreak >= 2) {
                        console.warn(JSON.stringify({ event: 'chat.curator_invalid_tool_streak', ip }));
                        break;
                    }
                    continue;
                }
                replyText = choice.message?.content || '';
                break;
            }

            if (!replyText) {
                if (lastFinish === 'tool_calls') {
                    console.warn(JSON.stringify({ event: 'chat.curator_max_tool_loops', exhibits: exhibits.length }));
                }
                replyText = exhibits.length
                    ? 'Have a look at the exhibit on the right — notice how they got started.'
                    : '(The Curator paused. Try asking about one form — "show me a parable" or "how did someone do free will?")';
            }
            const body = { reply: replyText };
            if (exhibits.length) body.exhibits = exhibits;
            return respond(200, body);
        } catch (err) {
            console.error('curator function error:', err && err.stack || err);
            const status = (err.status >= 400 && err.status < 600) ? err.status : 500;
            if (status === 402) {
                return respond(503, { error: 'The classroom AI is temporarily unavailable. Please tell your teacher.' });
            }
            if (status === 429) {
                return respond(429, { error: 'The Curator is briefly busy. Try again in a few seconds.' });
            }
            // Don't leak upstream/internal detail to students.
            return respond(status, { error: 'Something went wrong reaching the Curator. Try again in a moment.' });
        }
    }

    // Portal mode: {token, message, history, pack?}
    // Legacy chamber mode: {messages: [{role,text}...], pack}
    let message = payload.message;
    let history = payload.history;
    const packId = typeof payload.pack === 'string' ? payload.pack : null;
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
            store = studentStore();
            state = await loadStudentState(store, studentId);
        }

        const systemMessage = buildSystemMessage(student, state, packId);
        // Use server-persisted history as source of truth for signed-in students
        const historyForAgent = student && state.chatHistory && state.chatHistory.length
            ? state.chatHistory
            : history;
        const conversation = buildConversationMessages(historyForAgent, message);

        const result = await runAgent({
            systemMessage,
            conversation,
            ctx: { store, studentId, state, anonymous: !student },
            ip,
        });

        // Persist updated chat history (signed-in only). Cap at 40 turns.
        if (student && store) {
            const newHistory = Array.isArray(state.chatHistory) ? state.chatHistory.slice() : [];
            newHistory.push({ role: 'user', content: message, ts: Date.now() });
            newHistory.push({ role: 'assistant', content: result.text, ts: Date.now() });
            state.chatHistory = newHistory.slice(-40);
            try {
                await saveStudentState(store, studentId, state);
            } catch (e) {
                console.error('chat: failed to persist chatHistory', e.message);
            }
        }

        const body = { reply: result.text };
        if (result.resourcesAdded.length) body.resources_added = result.resourcesAdded;
        if (result.workingQuestionSet !== null) body.working_question_set = result.workingQuestionSet;
        return respond(200, body);
    } catch (err) {
        console.error('chat function error:', err && err.stack || err);
        const status = (err.status >= 400 && err.status < 600) ? err.status : 500;
        if (status === 402) {
            return respond(503, { error: 'The classroom AI is temporarily unavailable. Please tell your teacher.' });
        }
        if (status === 429) {
            return respond(429, { error: 'The agent is briefly overloaded. Try again in a few seconds.' });
        }
        return respond(status, { error: err.message || 'Internal error' });
    }
};
