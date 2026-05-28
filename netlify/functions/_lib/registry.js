/**
 * registry.js -- Student roster for the Issues Study per-student portals.
 *
 * The student's id is their lowercase first name. The two Jameses are
 * disambiguated by house. The password is the lowercase surname.
 *
 * Surnames are stored here only because (a) the repo's trust model is
 * classroom-internal and (b) the rendered website never displays them.
 * If a stricter privacy posture is wanted later, swap to sha256(lowercase
 * surname) and adjust verifyPassword accordingly.
 */

'use strict';

const REGISTRY = {
    'annabel': {
        firstName: 'Annabel',
        password: 'wood',
    },
    'abigail': {
        firstName: 'Abigail',
        password: 'lindsay',
    },
    'clare': {
        firstName: 'Clare',
        password: 'palmer',
    },
    'grace': {
        firstName: 'Grace',
        password: 'ryder',
    },
    'millicent': {
        firstName: 'Millicent',
        password: 'gilbert-rugless',
    },
    'jim': {
        firstName: 'Jim',
        password: 'howie',
    },
    'james': {
        firstName: 'James',
        password: 'norris',
    },
    'porsha': {
        firstName: 'Porsha',
        password: 'bates',
    },
    'ripley': {
        firstName: 'Ripley',
        password: 'valentine',
    },
};

// Public roster: just what the landing page needs to render buttons.
// Surname/password intentionally omitted.
function listStudents() {
    return Object.entries(REGISTRY).map(([id, s]) => ({
        id,
        firstName: s.firstName,
        house: s.house || null,
    }));
}

function getStudent(id) {
    return REGISTRY[id] || null;
}

function verifyPassword(id, candidate) {
    const s = REGISTRY[id];
    if (!s) return false;
    if (typeof candidate !== 'string') return false;
    return s.password === candidate.trim().toLowerCase();
}

module.exports = { listStudents, getStudent, verifyPassword };
