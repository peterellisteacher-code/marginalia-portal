/* ============================================================
   pins.js — Shared pinned-question state across pages
   Per-student: pins live in localStorage under a key scoped to the
   logged-in student id, and sync to the server (portal-state
   get_page/set_page, page id 'pins') so they follow the student
   across devices. localStorage stays the fast, offline-safe copy;
   the server is the cross-device source of truth.

   Consumers (bank, chamber, lab, portal) read synchronously via
   window.pins.* and should re-render on the 'pins:updated' window
   event, which fires when a background server sync changes the list.
   ============================================================ */

(function (window) {
    'use strict';

    var SESSION_KEY = 'marginalia.session';
    var LEGACY_KEY = 'marginalia.pins';   /* pre-login, device-global */

    function session() {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
        catch (e) { return null; }
    }
    function sid() {
        var s = session();
        return (s && s.id) || null;
    }
    function token() {
        var s = session();
        return (s && s.token) || null;
    }
    function KEY() {
        return 'marginalia.pins.' + (sid() || 'anon');
    }

    /* One-time adoption: pins made before logins existed move into the
       first student's list on this device. Low stakes (bookmarks), and it
       preserves continuity for the common one-student-per-device case. */
    function migrateLegacy() {
        try {
            if (!sid()) return;
            if (localStorage.getItem(KEY())) return;
            var legacy = localStorage.getItem(LEGACY_KEY);
            if (legacy) {
                localStorage.setItem(KEY(), legacy);
                localStorage.removeItem(LEGACY_KEY);
            }
        } catch (e) { /* ignore */ }
    }

    function read() {
        try {
            return JSON.parse(localStorage.getItem(KEY())) || [];
        } catch (e) {
            return [];
        }
    }

    function write(arr) {
        try {
            localStorage.setItem(KEY(), JSON.stringify(arr));
        } catch (e) {
            /* private mode / quota — pins just won't persist this session */
        }
    }

    function emitUpdated() {
        try { window.dispatchEvent(new CustomEvent('pins:updated')); }
        catch (e) { /* ignore */ }
    }

    /* ---- server sync (best-effort, debounced) ---- */

    var pushTimer = null;

    function pushToServer() {
        var t = token();
        if (!t) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(function () {
            fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'set_page', token: t, page: 'pins', data: read() })
            }).catch(function () { /* offline — local copy still holds */ });
        }, 800);
    }

    function pullFromServer() {
        var t = token();
        if (!t) return;
        fetch('/.netlify/functions/portal-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get_page', token: t, page: 'pins' })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res || res.ok !== true) return;
                if (Array.isArray(res.data)) {
                    /* Server is the cross-device truth when it holds a list. */
                    if (JSON.stringify(res.data) !== JSON.stringify(read())) {
                        write(res.data);
                        emitUpdated();
                    }
                } else if (res.data === null && read().length > 0) {
                    /* Server has never been written for this student — seed it
                       with this device's pins (covers the legacy migration). */
                    pushToServer();
                }
            })
            .catch(function () { /* offline — local copy still rules */ });
    }

    const pins = {
        list() {
            return read();
        },
        has(id) {
            return read().some(p => p.id === id);
        },
        add(id, text) {
            const arr = read();
            if (arr.some(p => p.id === id)) return;
            arr.push({ id, text, addedAt: Date.now() });
            write(arr);
            pushToServer();
        },
        remove(id) {
            write(read().filter(p => p.id !== id));
            pushToServer();
        },
        clear() {
            write([]);
            pushToServer();
        },
        /** Re-pull from the server (pages may call after long idle). */
        sync: pullFromServer
    };

    migrateLegacy();
    window.pins = pins;
    pullFromServer();
})(window);
