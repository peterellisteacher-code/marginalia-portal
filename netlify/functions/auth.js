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

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
};

function respond(statusCode, body) {
    return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
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
