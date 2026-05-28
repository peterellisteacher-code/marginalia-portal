/**
 * cors.js -- Shared CORS allowlist for all Marginalia Netlify Functions.
 *
 * Allows the production origin + localhost:8888 (netlify dev). Reflects the
 * request's Origin back when allowed; falls back to the production origin
 * otherwise so the browser surfaces a clean CORS error instead of a wildcard.
 * Adds `Vary: Origin` so any CDN in front caches per-origin.
 */

'use strict';

const ALLOWED_ORIGINS = [
    'https://marginalia-issues-study.netlify.app',
    'http://localhost:8888',
];

function pickOrigin(event) {
    const origin = event?.headers?.origin || event?.headers?.Origin || '';
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    return ALLOWED_ORIGINS[0];
}

function corsHeaders(event, extra = {}) {
    return {
        'Access-Control-Allow-Origin': pickOrigin(event),
        'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json',
        ...extra,
    };
}

module.exports = { corsHeaders, ALLOWED_ORIGINS };
