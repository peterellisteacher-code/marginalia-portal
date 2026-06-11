/* ============================================================
   guard.js — Shared session guard for every page except the
   welcome page (index.html) and 404.html.

   Load this as a BLOCKING script at the end of <head> so a
   logged-out visitor is redirected before the page paints.

   - Session lives in localStorage under 'marginalia.session'
     ({ token, id, firstName }), shared across tabs and surviving
     browser restarts. (It used to live in sessionStorage, which
     is per-tab — that is why opening a page in a new tab used to
     "log students out".)
   - Expiry is checked client-side by decoding the token payload
     (id|expiry|hmac). No server round-trip per page view: the
     functions that actually do anything verify the HMAC anyway,
     so this gate is about workflow, not cryptography.
   - Exposes window.MarginaliaSession for page scripts.
   - On DOM ready, appends "my desk" + "log out · Name" to the
     standard .site-nav so every page routes back to the portal.
   ============================================================ */

(function () {
    'use strict';

    var KEY = 'marginalia.session';

    /* One release window of migration: adopt a session left in the old
       per-tab sessionStorage slot so nobody is bounced mid-lesson. */
    try {
        if (!localStorage.getItem(KEY) && sessionStorage.getItem(KEY)) {
            localStorage.setItem(KEY, sessionStorage.getItem(KEY));
            sessionStorage.removeItem(KEY);
        }
    } catch (e) { /* storage unavailable — the redirect below handles it */ }

    function read() {
        try { return JSON.parse(localStorage.getItem(KEY)); }
        catch (e) { return null; }
    }

    /** Decode the HMAC token's expiry (ms epoch) without verifying it. */
    function expiryOf(token) {
        if (typeof token !== 'string' || !token) return 0;
        try {
            var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
            var parts = atob(b64).split('|');
            if (parts.length !== 3) return 0;
            var exp = Number(parts[1]);
            return isFinite(exp) ? exp : 0;
        } catch (e) { return 0; }
    }

    function isValid(s) {
        return !!(s && s.token && s.id && expiryOf(s.token) > Date.now());
    }

    function clear() {
        try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
        try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    }

    var session = read();
    if (!isValid(session)) {
        clear();
        var here = (location.pathname.split('/').pop() || '').replace(/[^a-z0-9_.-]/gi, '');
        location.replace('index.html' + (here ? '?from=' + encodeURIComponent(here) : ''));
        /* The parser keeps going briefly while the navigation starts; page
           scripts below should treat a missing session defensively. */
    }

    window.MarginaliaSession = {
        get: read,
        isValid: function () { return isValid(read()); },
        token: function () { var s = read(); return (s && s.token) || null; },
        id: function () { var s = read(); return (s && s.id) || null; },
        firstName: function () { var s = read(); return (s && s.firstName) || ''; },
        logout: function () { clear(); window.location.href = 'index.html'; },
        /** Redirect to the welcome page — call when a function returns 401. */
        expire: function () { clear(); window.location.replace('index.html'); }
    };

    /* ---- second gate: confirm the token still verifies server-side ----
       Catches tampered tokens (client-side expiry decode can't). Network
       hiccups are tolerated — we keep the cached session rather than lock
       a student out over a blip; the functions re-verify everything anyway. */
    if (isValid(session)) {
        fetch('/.netlify/functions/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify', token: session.token })
        })
            .then(function (r) {
                /* Only an explicit rejection bounces; a 5xx or weird payload
                   is a server problem, not a bad session. */
                if (r.status === 401) {
                    clear();
                    location.replace('index.html');
                }
            })
            .catch(function () { /* offline / function down — keep the session */ });
    }

    /* ---- header wiring (after DOM is ready) ---- */
    document.addEventListener('DOMContentLoaded', function () {
        var nav = document.querySelector('.site-nav');
        if (!nav || !isValid(read())) return;

        if (!nav.querySelector('a[href="portal.html"]')) {
            var desk = document.createElement('a');
            desk.href = 'portal.html';
            desk.className = 'nav-desk';
            desk.textContent = 'my desk';
            nav.appendChild(desk);
        }

        var name = window.MarginaliaSession.firstName();
        var out = document.createElement('button');
        out.type = 'button';
        out.className = 'nav-logout';
        out.textContent = 'log out' + (name ? ' · ' + name : '');
        out.addEventListener('click', window.MarginaliaSession.logout);
        nav.appendChild(out);
    });
})();
