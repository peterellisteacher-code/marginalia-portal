/* ============================================================
   portal.js — Per-student portal page wiring
   SACE Stage 1 Philosophy Issues Study — Marginalia
   ============================================================ */

(function () {
    'use strict';

    /* ---- module-scope state ---- */
    let session = null;          // { token, id, firstName }
    let questionsCache = null;   // array from data/questions.json
    let chatHistory = [];        // in-memory: [{role, content}, ...] last 6 kept
    let activePack = null;       // pack id (e.g. 'stage1_existentialism') or null
    let currentResources = [];   // the server's current resource list (refetched after chat)
    let workingQLastSaved = '';  // tracks last successfully saved value to detect changes
    let saveDebounceTimer = null;

    /* ---- DOM hooks ---- */
    const welcomeLabel   = document.getElementById('welcomeLabel');
    const workingQInput  = document.getElementById('workingQ');
    const workingQStatus = document.getElementById('workingQStatus');
    const shelf          = document.getElementById('shelf');
    const shelfEmpty     = document.getElementById('shelfEmpty');
    const pinnedStrip    = document.getElementById('pinnedStrip');
    const packChips      = document.getElementById('packChips');
    const pinnedSection  = document.getElementById('pinnedSection');
    const chatStream     = document.getElementById('chatStream');
    const chatInput      = document.getElementById('chatInput');
    const chatSendBtn    = document.getElementById('chatSendBtn');
    const logoutBtn      = document.getElementById('logoutBtn');
    const savePdfBtn     = document.getElementById('savePdfBtn');

    /* ================================================================
       UTILITIES
    ================================================================ */

    /** Safe text insertion — never use innerHTML with user content. */
    function setText(el, text) {
        el.textContent = text;
    }

    /** Extract YouTube video ID from a URL, or null. */
    function getYouTubeId(url) {
        if (!url) return null;
        try {
            const u = new URL(url);
            if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
            if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
        } catch (e) { /* ignore parse errors */ }
        return null;
    }

    /** Redirect to login, clearing session. */
    function redirectToLogin() {
        try { localStorage.removeItem('marginalia.session'); } catch (e) { /* ignore */ }
        try { sessionStorage.removeItem('marginalia.session'); } catch (e) { /* ignore */ }
        window.location.href = 'index.html';
    }

    /** Truncate a string to maxLen, appending ellipsis if trimmed. */
    function truncate(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
    }

    /* ================================================================
       LOCAL CACHE (localStorage-first persistence)
       The portal mirrors all per-student state to localStorage, keyed by
       student id, so work survives between sessions ON THIS DEVICE even if
       the server (Netlify Blobs) is briefly unavailable. The server stays
       the cross-device source of truth and is written best-effort; the
       browser copy is the resilient fallback.
    ================================================================ */

    const LOCAL_PREFIX = 'marginalia.portal.';

    function localKey() {
        return LOCAL_PREFIX + (session && session.id ? session.id : 'unknown');
    }

    function readLocal() {
        try { return JSON.parse(localStorage.getItem(localKey())) || {}; }
        catch (e) { return {}; }
    }

    /** Shallow-merge a patch into the per-student local cache. */
    function writeLocal(patch) {
        try {
            const next = Object.assign({}, readLocal(), patch, { updatedAt: Date.now() });
            localStorage.setItem(localKey(), JSON.stringify(next));
            return next;
        } catch (e) {
            /* private mode / quota exceeded — server sync still applies */
            return null;
        }
    }

    /* Each student's negotiated starting question, from their submitted
       proposal. Seeded on first login when neither the server nor this device
       already holds a question. Students who did not submit a usable proposal
       are intentionally absent — they keep the placeholder and negotiate one
       in class / with the agent. */
    const SEED_QUESTIONS = {
        james:     'Can we ever be certain of anything, or is all knowledge provisional?',
        annabel:   'Does brain death mean the person has died, even if the body is alive?',
        millicent: 'Is only the present real, or do the past and future exist as well?',
        grace:     'Should we trust our gut feelings about people more than our careful judgments?',
        abigail:   'Could empirical measurement definitively resolve the debate over whether the soul is a form of energy or a metaphysical entity?',
        clare:     'If a person’s memories were completely erased but their soul remained unchanged, would they still be the same person, or would they become someone new?',
    };

    /** Low-level server write for the working question (no change-detection
        guard — callers decide when to send). Returns true on success. */
    async function pushWorkingQuestion(value) {
        if (!value) return false;
        try {
            const r = await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'set_working_question',
                    token: session.token,
                    workingQuestion: value,
                }),
            });
            const data = await r.json().catch(function () { return {}; });
            return r.ok && data.ok !== false;
        } catch (e) {
            return false;
        }
    }

    /* ================================================================
       AUTH / INIT
    ================================================================ */

    async function init() {
        /* 1. Read session from localStorage (shared across tabs). Adopt a
           session left in the old per-tab sessionStorage slot so nobody is
           bounced by the upgrade mid-lesson. */
        try {
            if (!localStorage.getItem('marginalia.session') && sessionStorage.getItem('marginalia.session')) {
                localStorage.setItem('marginalia.session', sessionStorage.getItem('marginalia.session'));
                sessionStorage.removeItem('marginalia.session');
            }
        } catch (e) { /* storage unavailable — handled below */ }
        const raw = localStorage.getItem('marginalia.session');
        if (!raw) { redirectToLogin(); return; }

        try {
            session = JSON.parse(raw);
        } catch (e) {
            redirectToLogin();
            return;
        }

        if (!session || !session.token) { redirectToLogin(); return; }

        /* 2. Verify token with server */
        let verifyData;
        try {
            const r = await fetch('/.netlify/functions/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify', token: session.token }),
            });
            verifyData = await r.json();
            if (!r.ok || !verifyData.ok) { redirectToLogin(); return; }
        } catch (e) {
            /* Network blip (not a rejected token) — don't lock the student out;
               match shared/guard.js and keep the cached session. The token still
               gates the actual data calls server-side. */
            verifyData = null;
        }

        /* Update firstName/id from server in case they changed. session.id is
           the cache + seed key, so make sure it is populated. */
        if (verifyData) {
            session.firstName = verifyData.firstName || session.firstName;
            session.id = verifyData.id || session.id;
        }

        /* 3. Set welcome label */
        setText(welcomeLabel, 'Welcome, ' + session.firstName);

        /* 4. Prefetch questions.json (async, non-blocking for main load) */
        loadQuestionsCache();

        /* 5. Load portal state (working question + resources) */
        await loadPortalState();

        /* 6. Render pinned questions (and re-render when a server sync
           changes them — pins.js fires 'pins:updated') */
        renderPinnedStrip();
        window.addEventListener('pins:updated', renderPinnedStrip);

        /* 7. Wire up events */
        wireEvents();
        wirePackChips();
    }

    /* ================================================================
       QUESTIONS CACHE
    ================================================================ */

    async function loadQuestionsCache() {
        if (questionsCache) return questionsCache;
        try {
            const r = await fetch('data/questions.json');
            if (!r.ok) return null;
            const data = await r.json();
            questionsCache = Array.isArray(data.questions) ? data.questions : [];
        } catch (e) {
            questionsCache = [];
        }
        return questionsCache;
    }

    function findQuestion(id) {
        if (!questionsCache) return null;
        return questionsCache.find(function (q) { return q.id === id; }) || null;
    }

    /** Re-fetch just the resource shelf from the server and re-render it.
        Used after the agent adds a resource — deliberately does NOT touch the
        working question, chat history, or seeding (that's loadPortalState's job,
        run once on load). */
    async function refreshResources() {
        try {
            const r = await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'load', token: session.token }),
            });
            const data = await r.json();
            if (r.ok && Array.isArray(data.resources)) {
                renderShelf(data.resources);   // renderShelf also mirrors to localStorage
            }
        } catch (e) {
            /* non-fatal — the shelf just won't refresh until next load */
        }
    }

    /* ================================================================
       PORTAL STATE — load
    ================================================================ */

    async function loadPortalState() {
        /* localStorage-first: read this device's cache, then try the server.
           Server wins when it is reachable AND holds content; otherwise the
           local copy keeps the student working. When neither has a question,
           seed the student's negotiated proposal (first login only). */
        const local = readLocal();

        let server = null;
        let serverOk = false;
        try {
            const r = await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'load', token: session.token }),
            });
            const data = await r.json();
            if (r.ok && data.ok !== false) { server = data; serverOk = true; }
        } catch (e) {
            /* offline / server error — fall back to the local cache below */
        }

        /* Presence helper: did the server actually send this field? If so it is
           authoritative even when empty ("" / null / []), so a deliberate clear
           on one device is not resurrected from stale local data. We only fall
           back to local/seed when the server did NOT supply the field. */
        const has = function (obj, key) { return obj && Object.prototype.hasOwnProperty.call(obj, key); };

        /* ---- Working question: server (if present) > local > seed ---- */
        let wq = '';
        let fromSeed = false;
        if (serverOk && has(server, 'workingQuestion')) {
            wq = server.workingQuestion || '';
        } else if (local.workingQuestion) {
            wq = local.workingQuestion;
        } else if (!local.seeded && Object.prototype.hasOwnProperty.call(SEED_QUESTIONS, session.id)) {
            wq = SEED_QUESTIONS[session.id];
            fromSeed = true;
        }
        workingQInput.value = wq;
        workingQLastSaved = wq;

        /* ---- Active pack: server (if present, even null) > local ---- */
        const pack = (serverOk && has(server, 'activePack')) ? (server.activePack || null)
                   : (local.activePack || null);
        if (pack) renderActivePack(pack);

        /* ---- Resources: server (if present, even []) > local ---- */
        const resources = (serverOk && Array.isArray(server.resources)) ? server.resources
                        : (Array.isArray(local.resources) ? local.resources : []);
        currentResources = resources;
        renderShelf(currentResources);

        /* ---- Chat history: server (if present, even []) > local ---- */
        const history = (serverOk && Array.isArray(server.chatHistory)) ? server.chatHistory
                      : (Array.isArray(local.chatHistory) ? local.chatHistory : []);
        if (history.length > 0) {
            chatHistory = history.slice();
            renderPersistedHistory(history);
        }

        /* ---- Mirror the resolved state back to this device ---- */
        writeLocal({
            workingQuestion: wq,
            activePack: pack || null,
            resources: resources,
            chatHistory: history,
            seeded: true,
        });

        /* ---- Sync up to the server when it is missing the question we resolved
           (a fresh seed, or a local value the server never received). This is
           what lets the agent see the student's question and what carries it
           across devices. Best-effort; the local copy already holds it. ---- */
        if (wq && (!serverOk || !has(server, 'workingQuestion'))) {
            pushWorkingQuestion(wq).then(function (ok) {
                if (ok && fromSeed) {
                    setText(workingQStatus, 'Your question is loaded and ready.');
                    setTimeout(function () {
                        if (workingQStatus.textContent === 'Your question is loaded and ready.') {
                            setText(workingQStatus, '');
                        }
                    }, 3000);
                }
            });
        }
    }

    function renderPersistedHistory(history) {
        /* Remove the default "Start by saying…" system bubble */
        Array.from(chatStream.querySelectorAll('.chat-msg--system')).forEach(function (el) {
            el.remove();
        });

        /* Lead-in marker so the student knows what they're seeing */
        const marker = document.createElement('div');
        marker.className = 'chat-msg chat-msg--system';
        const markerBody = document.createElement('div');
        markerBody.className = 'chat-msg__body';
        markerBody.style.background = 'transparent';
        markerBody.style.border = 'none';
        markerBody.style.padding = '0';
        markerBody.style.fontStyle = 'italic';
        setText(markerBody, '— picking up where you left off —');
        marker.appendChild(markerBody);
        chatStream.appendChild(marker);

        history.forEach(function (turn) {
            const role = (turn.role === 'assistant' || turn.role === 'model') ? 'agent' : 'user';
            const text = String(turn.content || turn.text || '');
            if (text) addMsg(role, text);
        });
    }

    /* ================================================================
       WORKING QUESTION — autosave
    ================================================================ */

    async function saveWorkingQuestion() {
        const value = workingQInput.value.trim();

        /* Normalise: compare trimmed against last saved trimmed */
        if (value === workingQLastSaved.trim()) return;

        /* Local first. NOTE: localStorage can throw (Safari Private Mode throws
           on every write; quota can be exceeded), so writeLocal returns null on
           failure — we must not claim "Saved on this device" when it didn't. */
        const localOk = writeLocal({ workingQuestion: value }) !== null;
        workingQLastSaved = value;

        /* The server rejects an empty question (and keeps the last non-empty
           one). Locally we've recorded the clear; don't show an error. */
        if (!value) {
            const m = localOk ? 'Saved on this device' : 'Cleared (this device can’t save — keep this tab open)';
            setText(workingQStatus, m);
            scheduleStatusClear(m);
            return;
        }

        setText(workingQStatus, 'Saving…');
        const serverOk = await pushWorkingQuestion(value);
        let msg;
        if (serverOk) msg = 'Saved';                       // server has it — safe across devices
        else if (localOk) msg = 'Saved on this device';    // offline but this browser kept it
        else msg = 'Not saved — keep this tab open and tell your teacher';  // neither worked
        setText(workingQStatus, msg);
        scheduleStatusClear(msg);
    }

    /** Clear the working-question status after 2s, but only if it hasn't been
        replaced by a newer message in the meantime. */
    function scheduleStatusClear(expected) {
        setTimeout(function () {
            if (workingQStatus.textContent === expected) {
                setText(workingQStatus, '');
            }
        }, 2000);
    }

    /* ================================================================
       RESOURCE SHELF
    ================================================================ */

    function renderShelf(resources) {
        currentResources = Array.isArray(resources) ? resources : [];

        /* Mirror to this device so the shelf survives an offline reload. */
        writeLocal({ resources: currentResources });

        if (currentResources.length === 0) {
            shelfEmpty.removeAttribute('hidden');
            /* Remove any existing resource cards */
            Array.from(shelf.querySelectorAll('.res-card')).forEach(function (el) {
                el.remove();
            });
            return;
        }

        shelfEmpty.setAttribute('hidden', '');

        /* Build a set of already-rendered resource IDs to avoid re-adding */
        const existing = new Set(
            Array.from(shelf.querySelectorAll('[data-resource-id]'))
                .map(function (el) { return el.dataset.resourceId; })
        );

        currentResources.forEach(function (res) {
            if (existing.has(String(res.id))) return; /* already rendered */
            const card = buildResCard(res);
            shelf.appendChild(card);
            /* Drop --new class after animation completes */
            setTimeout(function () { card.classList.remove('res-card--new'); }, 600);
        });

        /* Remove cards whose IDs are no longer in the list */
        Array.from(shelf.querySelectorAll('[data-resource-id]')).forEach(function (el) {
            const id = el.dataset.resourceId;
            if (!currentResources.some(function (r) { return String(r.id) === id; })) {
                el.remove();
            }
        });
    }

    function buildResCard(res) {
        const ytId = getYouTubeId(res.url);

        const article = document.createElement('article');
        article.className = 'res-card res-card--new';
        article.dataset.resourceId = String(res.id);

        /* ✕ remove button */
        const removeBtn = document.createElement('button');
        removeBtn.className = 'res-card__remove';
        removeBtn.setAttribute('aria-label', 'Remove this resource');
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', function () {
            removeResource(res.id, article);
        });
        article.appendChild(removeBtn);

        /* kind */
        const kindP = document.createElement('p');
        kindP.className = 'res-card__kind';
        setText(kindP, res.kind || (ytId ? 'video' : 'link'));
        article.appendChild(kindP);

        /* title with link */
        const titleH3 = document.createElement('h3');
        titleH3.className = 'res-card__title';
        const titleA = document.createElement('a');
        titleA.href = res.url || '#';
        titleA.target = '_blank';
        titleA.rel = 'noopener';
        setText(titleA, res.title || res.url || 'Resource');
        titleH3.appendChild(titleA);
        article.appendChild(titleH3);

        /* youtube thumbnail */
        if (ytId) {
            const thumb = document.createElement('img');
            thumb.className = 'res-card__thumb';
            thumb.src = 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg';
            thumb.alt = '';
            thumb.loading = 'lazy';
            article.appendChild(thumb);
        }

        /* description */
        if (res.description) {
            const descP = document.createElement('p');
            descP.className = 'res-card__desc';
            setText(descP, res.description);
            article.appendChild(descP);
        }

        /* actions row */
        const actions = document.createElement('div');
        actions.className = 'res-card__actions';

        if (ytId) {
            const watchBtn = document.createElement('button');
            watchBtn.className = 'btn btn--ghost btn--small';
            watchBtn.dataset.action = 'embed';
            watchBtn.textContent = 'Watch here';
            watchBtn.addEventListener('click', function () {
                embedYouTube(article, ytId);
            });
            actions.appendChild(watchBtn);

            const doneBtn = document.createElement('button');
            doneBtn.className = 'btn btn--ghost btn--small';
            doneBtn.dataset.action = 'finished-watching';
            doneBtn.textContent = 'I’ve finished watching';
            doneBtn.addEventListener('click', function () {
                const title = (res.title || 'this video');
                /* Pass the videoId in the message so the agent's
                   youtube_transcript tool has the id without inferring. */
                const idTag = res.videoId ? ' (videoId: ' + res.videoId + ')' : '';
                const msg = 'I just finished watching ‘' + title + '’' + idTag +
                    '. Read the transcript and ask me something Socratic about what I saw.';
                sendChat(msg);
            });
            actions.appendChild(doneBtn);
        }

        const explainBtn = document.createElement('button');
        explainBtn.className = 'btn btn--ghost btn--small';
        explainBtn.dataset.action = 'explain';
        explainBtn.textContent = 'Explain plainly';
        explainBtn.addEventListener('click', function () {
            const title = (res.title || res.url || 'this resource');
            const msg = 'Can you explain ‘' + title + '’ to me in plain English, like I’m new to philosophy?';
            sendChat(msg);
        });
        actions.appendChild(explainBtn);

        article.appendChild(actions);
        return article;
    }

    function embedYouTube(card, ytId) {
        /* Replace thumbnail img (if present) with iframe; disable Watch button */
        const thumb = card.querySelector('.res-card__thumb');
        const titleEl = card.querySelector('.res-card__title');
        const cardTitle = titleEl ? titleEl.textContent.trim() : 'YouTube video';
        const iframe = document.createElement('iframe');
        iframe.className = 'yt-embed';
        iframe.src = 'https://www.youtube-nocookie.com/embed/' + ytId + '?rel=0&modestbranding=1';
        iframe.title = 'YouTube video: ' + cardTitle;  /* WCAG SC 4.1.2 — name */
        iframe.allowFullscreen = true;
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
        if (thumb) {
            thumb.replaceWith(iframe);
        } else {
            /* Insert after title */
            const title = card.querySelector('.res-card__title');
            if (title && title.nextSibling) {
                card.insertBefore(iframe, title.nextSibling);
            } else {
                card.appendChild(iframe);
            }
        }
        /* Disable the Watch button so it can't be clicked twice */
        const watchBtn = card.querySelector('[data-action="embed"]');
        if (watchBtn) {
            watchBtn.disabled = true;
            watchBtn.textContent = 'Playing';
        }
    }

    async function removeResource(resourceId, cardEl) {
        /* Optimistic removal */
        cardEl.remove();
        currentResources = currentResources.filter(function (r) {
            return String(r.id) !== String(resourceId);
        });
        writeLocal({ resources: currentResources });
        if (currentResources.length === 0) {
            shelfEmpty.removeAttribute('hidden');
        }

        try {
            await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'remove_resource',
                    token: session.token,
                    resourceId: resourceId,
                }),
            });
        } catch (e) {
            /* Non-fatal: optimistic removal already happened.
               A page reload will re-sync from server. */
        }
    }

    /* ================================================================
       CHAT
    ================================================================ */

    function addMsg(role, text) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-msg chat-msg--' + role;

        const who = document.createElement('div');
        who.className = 'chat-msg__who';
        setText(who, role === 'user' ? 'you' : 'agent');
        wrapper.appendChild(who);

        const body = document.createElement('div');
        body.className = 'chat-msg__body';
        setText(body, text);
        wrapper.appendChild(body);

        chatStream.appendChild(wrapper);
        chatStream.scrollTop = chatStream.scrollHeight;
        return wrapper;
    }

    async function sendChat(messageText) {
        if (!messageText) return;

        /* Clear input if wired from the send button path */
        chatInput.value = '';

        /* Render user bubble immediately */
        addMsg('user', messageText);

        /* Maintain in-memory history (keep last 6 turns = 3 pairs) */
        chatHistory.push({ role: 'user', content: messageText });
        const historySlice = chatHistory.slice(-6);

        /* Disable send while in-flight */
        chatSendBtn.disabled = true;
        chatInput.disabled = true;

        /* Show typing indicator */
        const typingEl = document.createElement('div');
        typingEl.className = 'chat-msg chat-msg--agent';
        const typingBody = document.createElement('div');
        typingBody.className = 'chat-msg__body';
        typingBody.style.color = 'var(--aged)';
        typingBody.style.fontStyle = 'italic';
        setText(typingBody, 'Thinking…');
        typingEl.appendChild(typingBody);
        chatStream.appendChild(typingEl);
        chatStream.scrollTop = chatStream.scrollHeight;

        let reply = '';
        try {
            const r = await fetch('/.netlify/functions/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: session.token,
                    message: messageText,
                    history: historySlice,
                    pack: activePack,
                }),
            });
            const data = await r.json();

            typingEl.remove();

            if (!r.ok) {
                reply = 'Something went wrong. Try again in a moment.';
                addMsg('agent', reply);
            } else {
                reply = data.reply || '';
                if (reply) addMsg('agent', reply);

                /* If agent set a working question */
                if (data.working_question_set) {
                    workingQInput.value = data.working_question_set;
                    workingQLastSaved = data.working_question_set;
                    setText(workingQStatus, 'Agent updated your question');
                    setTimeout(function () {
                        if (workingQStatus.textContent === 'Agent updated your question') {
                            setText(workingQStatus, '');
                        }
                    }, 2000);
                }

                /* If new resources were added, refresh ONLY the shelf. (Calling
                   the full loadPortalState() here re-ran history rendering and
                   re-seeding mid-conversation, which duplicated chat bubbles and
                   re-showed the "picking up where you left off" marker.) */
                if (data.resources_added && data.resources_added.length > 0) {
                    await refreshResources();
                }
            }
        } catch (e) {
            typingEl.remove();
            reply = 'Could not reach the agent. Check your internet.';
            addMsg('agent', reply);
        }

        /* Record agent reply in history */
        if (reply) {
            chatHistory.push({ role: 'assistant', content: reply });
        }

        /* Mirror the conversation to this device (cap at 40 turns, matching the
           server) so a returning student keeps their thread even offline. */
        writeLocal({ chatHistory: chatHistory.slice(-40) });

        chatSendBtn.disabled = false;
        chatInput.disabled = false;
        chatInput.focus();
    }

    /* ================================================================
       PINNED QUESTIONS STRIP
    ================================================================ */

    async function renderPinnedStrip() {
        /* Ensure questions are loaded before we try to look them up */
        await loadQuestionsCache();

        /* Defensive guard: if pins.js failed to load (network hiccup, file
           missing on a previous deploy), do not crash the whole portal — just
           leave the pinned section hidden and continue. */
        if (!window.pins || typeof window.pins.list !== 'function') {
            return;
        }

        /* Idempotent: this re-runs when a background server sync updates the
           pins ('pins:updated'), so clear before re-appending. */
        pinnedStrip.textContent = '';

        const pins = window.pins.list();
        if (!pins || pins.length === 0) {
            if (pinnedSection) pinnedSection.setAttribute('hidden', '');
            return;
        }

        /* The section wrapper holds the hidden attribute (so the heading and
           hint are revealed together with the chips). The chips themselves
           append into the inner #pinnedStrip flex container. */
        pins.forEach(function (pin) {
            /* Look up full question text; fall back to the text stored in the pin */
            const found = findQuestion(pin.id);
            const fullText = (found && found.question) ? found.question : (pin.text || pin.id);

            const chip = document.createElement('button');
            chip.className = 'pinned-chip';
            chip.dataset.questionId = pin.id;
            chip.type = 'button';
            setText(chip, truncate(fullText, 60));
            chip.title = fullText; /* show full text on hover */

            chip.addEventListener('click', function () {
                workingQInput.value = fullText;
                /* Save directly rather than faking a blur event (the synthetic
                   blur didn't actually blur, and left the real blur handler to
                   double-save later). */
                saveWorkingQuestion();
                workingQInput.focus();
            });

            pinnedStrip.appendChild(chip);
        });

        if (pinnedSection) pinnedSection.removeAttribute('hidden');
    }

    /* ================================================================
       SAVE AS PDF
       Builds a clean, print-only document from the current state (working
       question + full conversation + resource shelf) and opens the browser
       print dialog, where "Save as PDF" is the standard destination. The live
       chat/sidebar use fixed-height scroll panes that print poorly, so we
       render a dedicated #portalPrint document instead (hidden on screen).
    ================================================================ */

    function ppHeading(text) {
        const h = document.createElement('h2');
        h.className = 'pp-h2';
        setText(h, text);
        return h;
    }

    function ppEmpty(text) {
        const p = document.createElement('p');
        p.className = 'pp-empty';
        setText(p, text);
        return p;
    }

    function buildPrintDoc() {
        const printEl = document.getElementById('portalPrint');
        if (!printEl) return;
        printEl.textContent = ''; /* clear any previous build */

        const name = (session && session.firstName) ? session.firstName : 'Student';
        let dateStr = '';
        try { dateStr = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }); }
        catch (e) { dateStr = ''; }

        const title = document.createElement('h1');
        title.className = 'pp-title';
        setText(title, 'Issues Study — working copy');
        printEl.appendChild(title);

        const meta = document.createElement('p');
        meta.className = 'pp-meta';
        setText(meta, name + (dateStr ? ' · ' + dateStr : ''));
        printEl.appendChild(meta);

        /* Working question */
        printEl.appendChild(ppHeading('My working question'));
        const wq = workingQInput.value.trim();
        if (wq) {
            const q = document.createElement('p');
            q.className = 'pp-question';
            setText(q, wq);
            printEl.appendChild(q);
        } else {
            printEl.appendChild(ppEmpty('(not chosen yet)'));
        }

        /* Conversation */
        printEl.appendChild(ppHeading('My conversation with the agent'));
        if (chatHistory && chatHistory.length) {
            chatHistory.forEach(function (turn) {
                const who = (turn.role === 'assistant' || turn.role === 'model') ? 'Agent' : 'You';
                const text = String(turn.content || turn.text || '').trim();
                if (!text) return;
                const t = document.createElement('div');
                t.className = 'pp-turn';
                const w = document.createElement('span');
                w.className = 'pp-who';
                setText(w, who);
                t.appendChild(w);
                t.appendChild(document.createTextNode(text));
                printEl.appendChild(t);
            });
        } else {
            printEl.appendChild(ppEmpty('(no conversation yet)'));
        }

        /* Resource shelf */
        printEl.appendChild(ppHeading('My resource shelf'));
        if (currentResources && currentResources.length) {
            currentResources.forEach(function (res) {
                const r = document.createElement('div');
                r.className = 'pp-res';
                const t = document.createElement('span');
                t.className = 'pp-res-title';
                setText(t, res.title || res.url || 'Resource');
                r.appendChild(t);
                if (res.url) {
                    r.appendChild(document.createElement('br'));
                    const u = document.createElement('span');
                    u.className = 'pp-res-url';
                    setText(u, res.url);
                    r.appendChild(u);
                }
                if (res.description) {
                    r.appendChild(document.createElement('br'));
                    r.appendChild(document.createTextNode(res.description));
                }
                printEl.appendChild(r);
            });
        } else {
            printEl.appendChild(ppEmpty('(nothing saved yet)'));
        }
    }

    function savePdf() {
        buildPrintDoc();
        window.print();
    }

    /* ================================================================
       EVENT WIRING
    ================================================================ */

    /* ================================================================
       PACK CHIPS (reading-focus selector)
    ================================================================ */

    function renderActivePack(packId) {
        activePack = packId || null;
        if (!packChips) return;
        Array.from(packChips.querySelectorAll('.pack-chip')).forEach(function (c) {
            c.setAttribute('aria-pressed', c.dataset.pack === activePack ? 'true' : 'false');
        });
    }

    async function persistActivePack(packId) {
        try {
            await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'set_active_pack',
                    token: session.token,
                    activePack: packId,
                }),
            });
        } catch (e) {
            /* Non-fatal — chip is set optimistically; reload will resync */
        }
    }

    function wirePackChips() {
        if (!packChips) return;
        packChips.addEventListener('click', function (ev) {
            const chip = ev.target.closest('.pack-chip');
            if (!chip) return;
            const requested = chip.dataset.pack;
            /* Clicking the active chip again clears the focus */
            const next = (activePack === requested) ? null : requested;
            renderActivePack(next);
            writeLocal({ activePack: next });
            persistActivePack(next);
        });
    }

    function wireEvents() {
        /* Logout */
        logoutBtn.addEventListener('click', function () {
            redirectToLogin();
        });

        /* Save as PDF */
        if (savePdfBtn) {
            savePdfBtn.addEventListener('click', savePdf);
        }

        /* Working question — blur */
        workingQInput.addEventListener('blur', function () {
            saveWorkingQuestion();
        });

        /* Working question — Enter key (not Shift+Enter) */
        workingQInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                workingQInput.blur(); /* blur triggers save */
            }
        });

        /* Chat send button */
        chatSendBtn.addEventListener('click', function () {
            const text = chatInput.value.trim();
            if (!text) return;
            sendChat(text);
        });

        /* Chat textarea — Enter sends, Shift+Enter newline */
        chatInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                const text = chatInput.value.trim();
                if (!text) return;
                sendChat(text);
            }
            /* Shift+Enter: browser default adds newline — no action needed */
        });
    }

    /* ================================================================
       BOOT
    ================================================================ */

    init();

})();
