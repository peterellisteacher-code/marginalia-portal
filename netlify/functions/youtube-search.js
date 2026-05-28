/**
 * youtube-search.js — Netlify Function: YouTube video search
 *
 * POST /.netlify/functions/youtube-search
 * Body: { token: string, query: string, maxResults?: number }
 * Returns: { ok: true, results: [{ videoId, title, description, channelTitle, publishedAt, thumbnail }] }
 *
 * Auth: HMAC-signed session token (same as chat.js) — 401 if invalid.
 * Rate limit: 20 requests per 5 minutes per IP (in-memory sliding window).
 * API: YouTube Data API v3 /search — requires YOUTUBE_API_KEY env var.
 */

'use strict';

const { authenticate } = require('./_lib/session');
const { corsHeaders } = require('./_lib/cors');

const FETCH_TIMEOUT_MS = 8000;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const MAX_RESULTS_CAP = 8;
const DEFAULT_MAX_RESULTS = 5;
const DESCRIPTION_MAX_CHARS = 280;
const YT_SEARCH_HOST = 'www.googleapis.com';
const YT_SEARCH_PATH = '/youtube/v3/search';

const rateBuckets = new Map(); // ip → number[] of recent timestamps

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

function getClientIp(event) {
    const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
    if (xff) return String(xff).split(',')[0].trim();
    return event.headers?.['client-ip'] || 'unknown';
}

/** Decode common HTML entities that appear in YouTube API titles/descriptions. */
function stripHtmlEntities(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

function trimDescription(str) {
    if (typeof str !== 'string') return '';
    const clean = stripHtmlEntities(str).replace(/\s+/g, ' ').trim();
    return clean.length > DESCRIPTION_MAX_CHARS
        ? clean.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…'
        : clean;
}

/** Select the highest-resolution thumbnail available. */
function pickThumbnail(thumbnails) {
    if (!thumbnails) return '';
    return (
        thumbnails.maxres?.url ||
        thumbnails.high?.url ||
        thumbnails.medium?.url ||
        thumbnails.default?.url ||
        ''
    );
}

/** Fetch JSON with an explicit timeout — avoids hanging the Function
 *  until Netlify's platform 10s ceiling if YouTube's API stalls. */
async function fetchJson(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.json();
}

exports.handler = async (event) => {
    const cors = corsHeaders(event);

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: cors };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'POST only' })
        };
    }

    // --- Auth ---
    const studentId = authenticate(event);
    if (!studentId) {
        return {
            statusCode: 401,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Invalid or expired session token.' })
        };
    }

    // --- Rate limit ---
    const ip = getClientIp(event);
    const limit = checkRateLimit(ip);
    if (!limit.ok) {
        return {
            statusCode: 429,
            headers: { ...cors, 'Retry-After': String(limit.retryAfter), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: `Too many requests — try again in ${limit.retryAfter}s.` })
        };
    }

    // --- Parse body ---
    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Invalid JSON body.' })
        };
    }

    const { query, maxResults } = payload;

    if (typeof query !== 'string' || !query.trim()) {
        return {
            statusCode: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: '`query` must be a non-empty string.' })
        };
    }

    const resultCount = Math.min(
        Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : DEFAULT_MAX_RESULTS,
        MAX_RESULTS_CAP
    );

    // --- API key ---
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        console.error('youtube-search: YOUTUBE_API_KEY env var is not set');
        return {
            statusCode: 500,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'YouTube API is not configured on the server. Set YOUTUBE_API_KEY in Netlify site settings.' })
        };
    }

    // --- Build YouTube API URL ---
    const params = new URLSearchParams({
        part: 'snippet',
        q: query.trim(),
        type: 'video',
        maxResults: String(resultCount),
        safeSearch: 'strict',
        relevanceLanguage: 'en',
        videoEmbeddable: 'true',
        key: apiKey
    });

    const url = `https://${YT_SEARCH_HOST}${YT_SEARCH_PATH}?${params.toString()}`;

    try {
        const data = await fetchJson(url);

        // YouTube API returns an `error` object on quota/auth failures
        if (data.error) {
            console.error('youtube-search: YouTube API error', data.error.code, data.error.message);
            return {
                statusCode: 502,
                headers: { ...cors, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: false, error: 'YouTube search failed. The API may be over quota or misconfigured.' })
            };
        }

        const items = Array.isArray(data.items) ? data.items : [];
        const results = items.map(item => {
            const s = item.snippet || {};
            return {
                videoId: item.id?.videoId || '',
                title: stripHtmlEntities(s.title || ''),
                description: trimDescription(s.description || ''),
                channelTitle: stripHtmlEntities(s.channelTitle || ''),
                publishedAt: s.publishedAt || '',
                thumbnail: pickThumbnail(s.thumbnails)
            };
        }).filter(r => r.videoId); // drop any items without a valid videoId

        console.log(JSON.stringify({
            event: 'youtube-search',
            ip,
            studentId,
            query: query.trim().slice(0, 80),
            resultCount: results.length
        }));

        return {
            statusCode: 200,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, results })
        };
    } catch (err) {
        console.error('youtube-search: fetch error', err.message);
        return {
            statusCode: 502,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Failed to reach YouTube API.' })
        };
    }
};
