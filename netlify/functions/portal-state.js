/**
 * portal-state.js — Netlify Function: per-student portal state (working question + resource shelf)
 *
 * POST /.netlify/functions/portal-state
 * Body: { action, token, ...action-specific fields }
 *
 * Actions:
 *   load                — returns { ok: true, workingQuestion, resources }
 *   set_working_question — { workingQuestion } — upserts; returns { ok: true }
 *   add_resource        — { resource: { kind, title, url?, description?, videoId?, thumbnail?, addedBy } }
 *                          returns { ok: true, resource: <stored resource> }
 *   remove_resource     — { resourceId } — returns { ok: true }
 *
 * Storage: Netlify Blobs, store "marginalia-students", key "students/<studentId>/state.json"
 */

'use strict';

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { authenticate } = require('./_lib/session');
const { corsHeaders } = require('./_lib/cors');

const STORE_NAME     = 'marginalia-students';
const SHELF_CAP      = 30;
const MAX_TITLE_LEN  = 140;
const MAX_DESC_LEN   = 280;
const MAX_Q_LEN      = 500;
const VALID_KINDS    = new Set(['web', 'youtube', 'note']);
const VALID_ADDED_BY = new Set(['agent', 'student']);

// CORS is built per-request from the shared allowlist. The json() helper
// below is bound to the event inside the handler so the existing call sites
// stay unchanged.

// ── Blob helpers ─────────────────────────────────────────────────────────────

// Legacy V1 Netlify Functions no longer receive an injected `event.blobs`
// payload, so connectLambda() can't wire Blobs credentials and getStore()
// throws "environment has not been configured". Per Netlify's guidance, V1
// functions must configure the store manually with siteID + token. Supplying
// both also routes via the Netlify API (read-after-write consistent), which
// is what the portal's load-after-save needs anyway.
const BLOBS_SITE_ID = process.env.BLOBS_SITE_ID || 'ce8fd3dc-cfdf-4859-80dc-7f0803591109';
const BLOBS_TOKEN   = process.env.NETLIFY_BLOBS_TOKEN || '';

function store(_context) {
    return getStore({ name: STORE_NAME, siteID: BLOBS_SITE_ID, token: BLOBS_TOKEN });
}

function stateKey(studentId) {
    return `students/${studentId}/state.json`;
}

// The chamber keeps its own conversation in a SEPARATE blob from the portal's
// state.json, so the two chat surfaces never overwrite each other.
function chamberKey(studentId) {
    return `students/${studentId}/chamber.json`;
}

const MAX_CHAMBER_TURNS = 40;   // keep the last ~20 exchanges
const MAX_TURN_LEN = 4000;      // cap each stored message

const VALID_PACKS = new Set([
    'stage1_existentialism',
    'stage1_virtue_compassion',
    'stage1_religion_ethics',
    'stage1_aesthetics',
    'stage1_mind_simulation',
    'lab_applied_normative_ethics',
    'stage1_reason_passion',
]);

const EMPTY_STATE = () => ({
    workingQuestion: '',
    resources: [],
    chatHistory: [],
    progressNotes: '',
    activePack: null,
    updatedAt: 0,
});

async function loadState(studentId, context) {
    try {
        const s = store(context);
        const data = await s.get(stateKey(studentId), { type: 'json' });
        if (!data) return EMPTY_STATE();
        // Defensive normalise
        return {
            workingQuestion: typeof data.workingQuestion === 'string' ? data.workingQuestion : '',
            resources: Array.isArray(data.resources) ? data.resources : [],
            chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory : [],
            progressNotes: typeof data.progressNotes === 'string' ? data.progressNotes : '',
            activePack: VALID_PACKS.has(data.activePack) ? data.activePack : null,
            updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0
        };
    } catch (err) {
        console.error('portal-state: blob read error', err);
        throw { isBlobError: true };
    }
}

async function saveState(studentId, state, context) {
    try {
        const s = store(context);
        await s.setJSON(stateKey(studentId), { ...state, updatedAt: Date.now() });
    } catch (err) {
        console.error('portal-state: blob write error', err);
        throw { isBlobError: true };
    }
}

// ── Validation helpers ────────────────────────────────────────────────────────

function trimCap(val, maxLen) {
    if (typeof val !== 'string') return '';
    return val.trim().slice(0, maxLen);
}

// Normalise a chamber transcript coming from the client (or blob) into a safe,
// capped array of {role:'user'|'model', text:string}.
function sanitizeConversation(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
        if (!t || typeof t !== 'object') continue;
        const role = t.role === 'model' ? 'model' : (t.role === 'user' ? 'user' : null);
        if (!role) continue;
        out.push({ role, text: typeof t.text === 'string' ? t.text.slice(0, MAX_TURN_LEN) : '' });
    }
    return out.slice(-MAX_CHAMBER_TURNS);
}

function isHttpUrl(val) {
    try {
        const u = new URL(val);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function validateResource(raw) {
    if (!raw || typeof raw !== 'object') return { error: 'resource must be an object' };

    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    if (!VALID_KINDS.has(kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` };

    const title = trimCap(raw.title, MAX_TITLE_LEN);
    if (!title) return { error: 'title is required' };

    const description = trimCap(raw.description, MAX_DESC_LEN);

    const addedBy = typeof raw.addedBy === 'string' && VALID_ADDED_BY.has(raw.addedBy)
        ? raw.addedBy
        : 'student';

    // kind-specific
    let url = '';
    let videoId = '';
    let thumbnail = '';

    if (kind === 'web' || kind === 'youtube') {
        url = trimCap(raw.url, 2048);
        if (!url) return { error: `url is required for kind "${kind}"` };
        if (!isHttpUrl(url)) return { error: 'url must be a valid http(s) URL' };
    }

    if (kind === 'youtube') {
        videoId = trimCap(raw.videoId, 20);
        if (!videoId) return { error: 'videoId is required for kind "youtube"' };
    }

    if (raw.thumbnail) {
        const th = trimCap(raw.thumbnail, 2048);
        if (isHttpUrl(th)) thumbnail = th;
        // silently drop invalid thumbnail rather than rejecting the whole resource
    }

    const resource = {
        id: crypto.randomBytes(6).toString('hex'),
        kind,
        title,
        description,
        addedBy,
        addedAt: Date.now()
    };
    if (url)       resource.url       = url;
    if (videoId)   resource.videoId   = videoId;
    if (thumbnail) resource.thumbnail = thumbnail;

    return { resource };
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function actionLoad(studentId, _payload, context, json) {
    const state = await loadState(studentId, context);
    return json(200, {
        ok: true,
        workingQuestion: state.workingQuestion,
        resources: state.resources,
        chatHistory: state.chatHistory,
        progressNotes: state.progressNotes,
        activePack: state.activePack,
    });
}

async function actionSetActivePack(studentId, payload, context, json) {
    // null/empty clears the active pack — the agent goes back to training-data
    // knowledge. Non-null must match a known pack id.
    const requested = payload.activePack;
    let activePack = null;
    if (typeof requested === 'string' && requested) {
        if (!VALID_PACKS.has(requested)) {
            return json(400, { error: `Unknown pack id: ${requested}` });
        }
        activePack = requested;
    }
    const state = await loadState(studentId, context);
    state.activePack = activePack;
    await saveState(studentId, state, context);
    return json(200, { ok: true, activePack });
}

async function actionSetWorkingQuestion(studentId, payload, context, json) {
    const wq = trimCap(payload.workingQuestion, MAX_Q_LEN);
    if (!wq) {
        return json(400, { error: 'workingQuestion must be a non-empty string under 500 characters' });
    }
    const state = await loadState(studentId, context);
    state.workingQuestion = wq;
    await saveState(studentId, state, context);
    return json(200, { ok: true });
}

async function actionAddResource(studentId, payload, context, json) {
    const { error, resource } = validateResource(payload.resource);
    if (error) return json(400, { error });

    const state = await loadState(studentId, context);
    if (state.resources.length >= SHELF_CAP) {
        return json(400, { error: 'Shelf full. Remove something first.' });
    }
    state.resources.push(resource);
    await saveState(studentId, state, context);
    return json(200, { ok: true, resource });
}

async function actionRemoveResource(studentId, payload, context, json) {
    const { resourceId } = payload;
    if (typeof resourceId !== 'string' || !resourceId) {
        return json(400, { error: 'resourceId is required' });
    }
    const state = await loadState(studentId, context);
    const idx = state.resources.findIndex(r => r.id === resourceId);
    if (idx === -1) return json(404, { error: 'Resource not found' });
    state.resources.splice(idx, 1);
    await saveState(studentId, state, context);
    return json(200, { ok: true });
}

// ── Chamber slot (separate blob from the portal's state.json) ──────────────────

async function actionChamberLoad(studentId, _payload, context, json) {
    try {
        const s = store(context);
        const data = await s.get(chamberKey(studentId), { type: 'json' });
        if (!data) {
            return json(200, { ok: true, conversation: [], workingQuestion: '', activePack: 'auto', updatedAt: 0 });
        }
        return json(200, {
            ok: true,
            conversation: sanitizeConversation(data.conversation),
            workingQuestion: typeof data.workingQuestion === 'string' ? data.workingQuestion.slice(0, MAX_Q_LEN) : '',
            activePack: typeof data.activePack === 'string' ? data.activePack : 'auto',
            updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
        });
    } catch (err) {
        console.error('portal-state: chamber blob read error', err);
        throw { isBlobError: true };
    }
}

async function actionChamberSave(studentId, payload, context, json) {
    const conversation = sanitizeConversation(payload.conversation);
    const workingQuestion = trimCap(payload.workingQuestion, MAX_Q_LEN);
    // activePack may be 'auto' (chamber default) or a known pack id.
    let activePack = 'auto';
    if (typeof payload.activePack === 'string' && payload.activePack) {
        activePack = (payload.activePack === 'auto' || VALID_PACKS.has(payload.activePack)) ? payload.activePack : 'auto';
    }
    try {
        const s = store(context);
        await s.setJSON(chamberKey(studentId), { conversation, workingQuestion, activePack, updatedAt: Date.now() });
    } catch (err) {
        console.error('portal-state: chamber blob write error', err);
        throw { isBlobError: true };
    }
    return json(200, { ok: true });
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event, _netlifyContext) => {
    const CORS = corsHeaders(event);
    const json = (statusCode, body, extra = {}) => ({
        statusCode,
        headers: { ...CORS, ...extra },
        body: JSON.stringify(body),
    });

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS };
    }
    if (event.httpMethod !== 'POST') {
        return json(405, { error: 'POST only' });
    }

    const studentId = authenticate(event);
    if (!studentId) {
        return json(401, { error: 'Unauthorised. Please log in again.' });
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (_) {
        return json(400, { error: 'Invalid JSON' });
    }

    const { action } = payload;

    // The store() helper is configured with explicit siteID + token (see top
    // of file) -- legacy V1 functions don't get Blobs creds auto-injected.
    try {
        switch (action) {
            case 'load':
                return await actionLoad(studentId, payload, undefined, json);
            case 'set_working_question':
                return await actionSetWorkingQuestion(studentId, payload, undefined, json);
            case 'add_resource':
                return await actionAddResource(studentId, payload, undefined, json);
            case 'remove_resource':
                return await actionRemoveResource(studentId, payload, undefined, json);
            case 'set_active_pack':
                return await actionSetActivePack(studentId, payload, undefined, json);
            case 'chamber_load':
                return await actionChamberLoad(studentId, payload, undefined, json);
            case 'chamber_save':
                return await actionChamberSave(studentId, payload, undefined, json);
            default:
                return json(400, { error: `Unknown action: "${action}". Valid: load, set_working_question, add_resource, remove_resource, set_active_pack, chamber_load, chamber_save` });
        }
    } catch (err) {
        if (err && err.isBlobError) {
            return json(500, { error: 'Storage error. Try again.' });
        }
        console.error('portal-state: unhandled error', err);
        return json(500, { error: 'Internal error' });
    }
};
