/**
 * session.js -- HMAC-signed session tokens for the per-student portal.
 *
 * Token format: base64url("<student_id>|<expiry_ms>|<hmac>") where
 * hmac = HMAC-SHA256(SESSION_SECRET, "<student_id>|<expiry_ms>").
 *
 * SESSION_SECRET must be set in Netlify env vars in production. In dev,
 * a fallback string is used (NOT secure -- only acceptable for `netlify dev`).
 *
 * Default lifetime: 30 days. The token now lives in localStorage (shared
 * across tabs, survives restarts), so a short lifetime would just force a
 * daily re-login without buying real security -- the password is a surname.
 */

'use strict';

const crypto = require('crypto');

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function secret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    // Refuse to start in production without a real secret. The fallback is
    // only acceptable for `netlify dev` where NETLIFY_DEV === 'true'.
    if (process.env.NETLIFY === 'true' && process.env.CONTEXT !== 'dev') {
        throw new Error(
            'SESSION_SECRET env var must be set in Netlify production. ' +
            'Set it with: netlify env:set SESSION_SECRET "$(openssl rand -hex 32)"'
        );
    }
    return 'dev-only-do-not-ship-this-set-SESSION_SECRET-in-netlify-env';
}

function sign(payload) {
    return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function issueToken(studentId) {
    const expiry = Date.now() + SESSION_LIFETIME_MS;
    const payload = `${studentId}|${expiry}`;
    const mac = sign(payload);
    return Buffer.from(`${payload}|${mac}`).toString('base64url');
}

function verifyToken(token) {
    if (typeof token !== 'string' || !token) return null;
    let decoded;
    try {
        decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch (e) {
        return null;
    }
    const parts = decoded.split('|');
    if (parts.length !== 3) return null;
    const [studentId, expiryStr, mac] = parts;
    const expiry = Number(expiryStr);
    if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
    const expected = sign(`${studentId}|${expiry}`);
    // Constant-time compare to resist timing attacks
    const a = Buffer.from(mac, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return studentId;
}

/** Extract token from request headers or body. Returns studentId or null. */
function authenticate(event) {
    const auth = event.headers?.authorization || event.headers?.Authorization;
    let token = null;
    if (auth && auth.startsWith('Bearer ')) {
        token = auth.slice(7);
    } else if (event.body) {
        try {
            const body = JSON.parse(event.body);
            if (body && typeof body.token === 'string') token = body.token;
        } catch (e) { /* fall through */ }
    }
    return verifyToken(token);
}

module.exports = { issueToken, verifyToken, authenticate };
