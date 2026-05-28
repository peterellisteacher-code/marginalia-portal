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
        sessionStorage.removeItem('marginalia.session');
        window.location.href = 'index.html';
    }

    /** Truncate a string to maxLen, appending ellipsis if trimmed. */
    function truncate(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
    }

    /* ================================================================
       AUTH / INIT
    ================================================================ */

    async function init() {
        /* 1. Read session from sessionStorage */
        const raw = sessionStorage.getItem('marginalia.session');
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
            redirectToLogin();
            return;
        }

        /* Update firstName from server in case it changed */
        session.firstName = verifyData.firstName || session.firstName;

        /* 3. Set welcome label */
        setText(welcomeLabel, 'Welcome, ' + session.firstName);

        /* 4. Prefetch questions.json (async, non-blocking for main load) */
        loadQuestionsCache();

        /* 5. Load portal state (working question + resources) */
        await loadPortalState();

        /* 6. Render pinned questions */
        renderPinnedStrip();

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

    /* ================================================================
       PORTAL STATE — load
    ================================================================ */

    async function loadPortalState() {
        let data;
        try {
            const r = await fetch('/.netlify/functions/portal-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'load', token: session.token }),
            });
            data = await r.json();
            if (!r.ok || !data.ok) {
                /* Non-fatal — portal still usable without persisted state */
                data = { ok: false, workingQuestion: '', resources: [], chatHistory: [] };
            }
        } catch (e) {
            data = { ok: false, workingQuestion: '', resources: [], chatHistory: [] };
        }

        const wq = data.workingQuestion || '';
        workingQInput.value = wq;
        workingQLastSaved = wq;

        /* Hydrate active pack chip from server state */
        if (data.activePack) {
            renderActivePack(data.activePack);
        }

        currentResources = Array.isArray(data.resources) ? data.resources : [];
        renderShelf(currentResources);

        /* Replay persisted chat history into the stream and the in-memory
           history array, so a returning student picks up where they left off. */
        const persistedHistory = Array.isArray(data.chatHistory) ? data.chatHistory : [];
        if (persistedHistory.length > 0) {
            chatHistory = persistedHistory.slice();
            renderPersistedHistory(persistedHistory);
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

        setText(workingQStatus, 'Saving…');

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
            const data = await r.json();
            if (r.ok && data.ok !== false) {
                workingQLastSaved = value;
                setText(workingQStatus, 'Saved');
                setTimeout(function () {
                    /* Only clear if still showing "Saved" — don't clobber a
                       concurrent status message */
                    if (workingQStatus.textContent === 'Saved') {
                        setText(workingQStatus, '');
                    }
                }, 2000);
            } else {
                setText(workingQStatus, 'Could not save. Check your internet.');
            }
        } catch (e) {
            setText(workingQStatus, 'Could not save. Check your internet.');
        }
    }

    /* ================================================================
       RESOURCE SHELF
    ================================================================ */

    function renderShelf(resources) {
        currentResources = Array.isArray(resources) ? resources : [];

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
            thumb.src = 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg';
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
        iframe.src = 'https://www.youtube.com/embed/' + ytId + '?rel=0';
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

                /* If new resources were added, refetch state so shelf is accurate */
                if (data.resources_added && data.resources_added.length > 0) {
                    await loadPortalState();
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

        const pins = window.pins.list();
        if (!pins || pins.length === 0) return; /* leave hidden */

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
                /* Trigger autosave by dispatching a blur event */
                workingQInput.dispatchEvent(new Event('blur'));
                workingQInput.focus();
            });

            pinnedStrip.appendChild(chip);
        });

        if (pinnedSection) pinnedSection.removeAttribute('hidden');
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
            persistActivePack(next);
        });
    }

    function wireEvents() {
        /* Logout */
        logoutBtn.addEventListener('click', function () {
            sessionStorage.removeItem('marginalia.session');
            window.location.href = 'index.html';
        });

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
