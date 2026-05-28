/**
 * youtube-transcript.js — Netlify Function: YouTube auto-caption fetch
 *
 * POST /.netlify/functions/youtube-transcript
 * Body: { token: string, videoId: string }
 * Returns: { ok: true, transcript: string, duration_seconds: number, language: string }
 *    or   { ok: false, error: string }
 *
 * Auth: HMAC-signed session token — 401 if invalid.
 * Rate limit: 10 requests per 5 minutes per IP (transcripts are larger payloads).
 * Package: youtube-transcript (npm) — fetches auto-generated captions without OAuth.
 *
 * Known limitations of youtube-transcript package:
 *   - Only works for videos that have captions enabled (auto-generated or manual).
 *   - Age-restricted, private, or embeds-disabled videos will throw.
 *   - Language selection is best-effort; falls back to whatever YouTube returns first.
 *   - Does not support live streams or premieres.
 *   - Very occasionally fails on legitimate public videos due to YouTube's inner API
 *     changes — the error message surfaces cleanly to the caller.
 */

'use strict';

const { YoutubeTranscript } = require('youtube-transcript');
const { authenticate } = require('./_lib/session');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const TRANSCRIPT_MAX_CHARS = 30_000;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

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
    return { ok: true };
}

function getClientIp(event) {
    const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
    if (xff) return String(xff).split(',')[0].trim();
    return event.headers?.['client-ip'] || 'unknown';
}

exports.handler = async (event) => {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'POST only' })
        };
    }

    // --- Auth ---
    const studentId = authenticate(event);
    if (!studentId) {
        return {
            statusCode: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Invalid or expired session token.' })
        };
    }

    // --- Rate limit ---
    const ip = getClientIp(event);
    const limit = checkRateLimit(ip);
    if (!limit.ok) {
        return {
            statusCode: 429,
            headers: { ...corsHeaders, 'Retry-After': String(limit.retryAfter), 'Content-Type': 'application/json' },
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
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: 'Invalid JSON body.' })
        };
    }

    const { videoId } = payload;

    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
        return {
            statusCode: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: '`videoId` must be an 11-character YouTube video ID.' })
        };
    }

    // --- Fetch transcript ---
    try {
        /** @type {Array<{ text: string, duration: number, offset: number }>} */
        const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });

        if (!Array.isArray(segments) || segments.length === 0) {
            return {
                statusCode: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ok: false,
                    error: 'No captions available for this video. The student can describe what they saw and the agent will work from that.'
                })
            };
        }

        // Join segments into a single transcript string
        let transcript = segments.map(s => (s.text || '').trim()).filter(Boolean).join(' ');

        // Compute total duration from last segment's offset + duration (both in ms)
        const last = segments[segments.length - 1];
        const duration_seconds = last
            ? Math.round(((last.offset || 0) + (last.duration || 0)) / 1000)
            : 0;

        // Detect language from first segment if available (the package may expose it)
        const language = segments[0]?.lang || 'en';

        // Cap at 30K characters
        if (transcript.length > TRANSCRIPT_MAX_CHARS) {
            transcript = transcript.slice(0, TRANSCRIPT_MAX_CHARS - 1) + '…';
        }

        console.log(JSON.stringify({
            event: 'youtube-transcript',
            ip,
            studentId,
            videoId,
            chars: transcript.length,
            duration_seconds,
            language
        }));

        return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, transcript, duration_seconds, language })
        };
    } catch (err) {
        // youtube-transcript throws for: no captions, age-restricted, private, disabled embeds
        console.warn('youtube-transcript: caption fetch failed', videoId, err.message);
        return {
            statusCode: 200, // deliberate 200 — the caller handles ok:false gracefully
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: false,
                error: 'No captions available for this video. The student can describe what they saw and the agent will work from that.'
            })
        };
    }
};
