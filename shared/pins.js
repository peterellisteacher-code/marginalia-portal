/* ============================================================
   pins.js — Shared pinned-question state across pages
   Uses localStorage so pins persist across sessions: the Issues Study runs
   over several days, so a student's pinned questions should still be there
   when they come back tomorrow. (Signed-in portal state also persists
   server-side; this covers the anonymous bank / lab / chamber path.)
   ============================================================ */

(function (window) {
    'use strict';

    const KEY = 'marginalia.pins';

    function read() {
        try {
            return JSON.parse(localStorage.getItem(KEY)) || [];
        } catch (e) {
            return [];
        }
    }

    function write(arr) {
        try {
            localStorage.setItem(KEY, JSON.stringify(arr));
        } catch (e) {
            /* private mode / quota — pins just won't persist this session */
        }
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
        },
        remove(id) {
            write(read().filter(p => p.id !== id));
        },
        clear() {
            write([]);
        }
    };

    window.pins = pins;
})(window);
