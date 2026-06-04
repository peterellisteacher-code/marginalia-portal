/* ============================================================
   gate.js — Per-student access gate for the whole site
   SACE Stage 1 Philosophy Issues Study — Marginalia

   Include this as the FIRST script in the <head> of every page that
   should require a login:

       <script src="shared/gate.js"></script>

   It runs synchronously, before the page body paints. If there is no
   signed-in session in this tab, it bounces the visitor to the login
   page (index.html) and remembers where they were heading so login can
   send them back. A signed-in session is then checked against the server
   (auth "verify"); an expired or tampered token also bounces to login.

   Do NOT include this on index.html (the login page) or 404.html.

   Trust model: this is a CLIENT-SIDE gate. It keeps casual visitors out
   and makes each student sign in, which is what the classroom needs. It
   is not a hard wall — the per-student data and the AI endpoints are the
   things that are actually protected server-side (HMAC session tokens in
   the Netlify Functions). See _design/04-per-student-portal.md.
   ============================================================ */

(function () {
    'use strict';

    var SESSION_KEY = 'marginalia.session';
    var RETURN_KEY = 'marginalia.returnTo';
    var LOGIN_PAGE = 'index.html';

    function readSession() {
        try {
            return JSON.parse(sessionStorage.getItem(SESSION_KEY));
        } catch (e) {
            return null;
        }
    }

    function rememberDestination() {
        try {
            // Same-origin relative path only — used to return the student to
            // the page they were trying to reach after they log in.
            sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
        } catch (e) { /* private mode — skip */ }
    }

    function goToLogin() {
        rememberDestination();
        // replace() so the protected page doesn't sit in history behind login.
        location.replace(LOGIN_PAGE);
    }

    var session = readSession();

    // First gate: no session token at all -> straight to login, before the
    // body renders (this script is synchronous and sits high in <head>).
    if (!session || !session.token) {
        goToLogin();
        return;
    }

    // Second gate: confirm the token still verifies server-side. This catches
    // expired (8h) or tampered tokens. Network hiccups are tolerated — we let
    // the existing session stand rather than locking a student out over a blip.
    fetch('/.netlify/functions/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', token: session.token })
    })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
            if (!data || !data.ok) {
                try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
                goToLogin();
            }
        })
        .catch(function () { /* offline / function down — keep the cached session */ });
})();
