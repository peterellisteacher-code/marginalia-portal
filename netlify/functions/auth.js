/**
 * auth.js -- POST /.netlify/functions/auth
 *
 * Three actions:
 *   - { action: "list" }          -> { students: [{id, firstName, house?}, ...] }
 *   - { action: "login", id, password } -> { ok: true, token, firstName } or 401
 *   - { action: "verify", token } -> { ok: true, id, firstName } or 401
 *
 * The password check is case-insensitive, trimmed, compared against the
 * student's lowercase surname. Issues an HMAC-signed session token good
 * for 8 hours.
 */

'use strict';

const { listStudents, getStudent, verifyPassword } = require('./_lib/registry');
const { issueToken, verifyToken } = require('./_lib/session');
const { corsHeaders } = require('./_lib/cors');

// Per-IP rate limit on login attempts. 9 students with low-entropy
// surnames as passwords means brute-force is otherwise trivial.
const LOGIN_LIMIT_MAX = 8;
const LOGIN_LIMIT_WINDOW_MS = 5 * 60_000;
const loginBuckets = new Map();

function getClientIp(event) {
    const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
    if (xff) return String(xff).split(',')[0].trim();
    return event.headers?.['client-ip'] || 'unknown';
}

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const cutoff = now - LOGIN_LIMIT_WINDOW_MS;
    const recent = (loginBuckets.get(ip) || []).filter(t => t > cutoff);
    if (recent.length >= LOGIN_LIMIT_MAX) {
        const retryAfterMs = recent[0] + LOGIN_LIMIT_WINDOW_MS - now;
        return { ok: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    loginBuckets.set(ip, recent);
    if (loginBuckets.size > 100 && Math.random() < 0.02) {
        for (const [k, v] of loginBuckets) {
            if (v.filter(t => t > cutoff).length === 0) loginBuckets.delete(k);
        }
    }
    return { ok: true };
}

exports.handler = async (event) => {
    const CORS = corsHeaders(event);
    const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return respond(400, { error: 'Invalid JSON' });
    }

    const action = payload.action;

    if (action === 'list') {
        return respond(200, { students: listStudents() });
    }

    if (action === 'login') {
        const ip = getClientIp(event);
        const limit = checkLoginRateLimit(ip);
        if (!limit.ok) {
            return {
                statusCode: 429,
                headers: { ...CORS, 'Retry-After': String(limit.retryAfter) },
                body: JSON.stringify({
                    error: `Too many login attempts. Try again in ${limit.retryAfter}s.`,
                }),
            };
        }
        // (CORS is captured by the respond closure above; the extra Retry-After
        //  header is merged in for this single 429 path.)
        const id = String(payload.id || '').trim().toLowerCase();
        const password = payload.password;
        if (!id || typeof password !== 'string') {
            return respond(400, { error: 'id and password required' });
        }
        if (!verifyPassword(id, password)) {
            return respond(401, { error: 'Wrong password.' });
        }
        const student = getStudent(id);
        return respond(200, {
            ok: true,
            token: issueToken(id),
            firstName: student.firstName,
            id,
        });
    }

    if (action === 'verify') {
        const studentId = verifyToken(payload.token);
        if (!studentId) return respond(401, { error: 'Invalid or expired token.' });
        const student = getStudent(studentId);
        if (!student) return respond(401, { error: 'Student not found.' });
        return respond(200, { ok: true, id: studentId, firstName: student.firstName });
    }

    return respond(400, { error: 'Unknown action.' });
};
