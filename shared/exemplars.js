/* ============================================================
   exemplars.js — The Showroom page wiring
   - Philosopher poster rail + lightbox
   - The Curator AI guide (chat.js mode:'exemplars') with a live
     exhibit panel the agent drives via the show_exhibit tool.
   ============================================================ */
(function () {
    'use strict';

    var esc = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    /* ============================================================
       1. PHILOSOPHER RAIL
       ============================================================ */
    var PHILOSOPHERS = [
        { file: 'descartes',  name: 'René Descartes',   note: 'Certainty through reason · epistemology' },
        { file: 'hume',       name: 'David Hume',        note: 'Knowledge from experience · epistemology' },
        { file: 'plato',      name: 'Plato',             note: 'Appearance vs reality · the Forms' },
        { file: 'aristotle',  name: 'Aristotle',         note: 'Virtue & the good life · ethics' },
        { file: 'mill',       name: 'John Stuart Mill',  note: 'Utilitarianism & liberty · ethics' },
        { file: 'kant',       name: 'Immanuel Kant',     note: 'Duty & the moral law · ethics' },
        { file: 'nietzsche',  name: 'Friedrich Nietzsche', note: 'Will to power, your own values' },
        { file: 'sartre',     name: 'Jean-Paul Sartre',  note: 'Radical freedom · existentialism' },
        { file: 'locke',      name: 'John Locke',        note: 'Blank slate & identity · mind' },
        { file: 'nagel',      name: 'Thomas Nagel',      note: 'Consciousness & the felt mind' }
    ];

    function buildRail() {
        var rail = document.getElementById('philRail');
        if (!rail) return;
        PHILOSOPHERS.forEach(function (p) {
            var fig = document.createElement('figure');
            fig.className = 'plate';
            var src = 'assets/exemplars/philosophers/' + p.file + '.png';
            fig.innerHTML =
                '<img class="plate__img" src="' + src + '" alt="Study poster of ' + esc(p.name) + ': portrait, dates, one big idea, and three plain-language panels explaining their position." data-zoom tabindex="0" role="button" aria-label="Enlarge the ' + esc(p.name) + ' poster">' +
                '<figcaption class="plate__caption"><strong>' + esc(p.name) + '</strong>' + esc(p.note) + '</figcaption>';
            rail.appendChild(fig);
        });
    }

    /* ============================================================
       2. LIGHTBOX (zoom any [data-zoom] image)
       ============================================================ */
    function wireLightbox() {
        var lb = document.getElementById('lightbox');
        var lbImg = document.getElementById('lightboxImg');
        var lbClose = document.getElementById('lightboxClose');
        if (!lb || !lbImg || !lbClose) return;
        var lastFocus = null;

        function open(src, alt) {
            lastFocus = document.activeElement;
            lbImg.src = src; lbImg.alt = alt || '';
            lb.hidden = false;
            lbClose.focus();
        }
        function close() {
            lb.hidden = true; lbImg.src = '';
            if (lastFocus && lastFocus.focus) lastFocus.focus();
        }

        document.addEventListener('click', function (e) {
            var trigger = e.target.closest('[data-zoom]');
            if (trigger) { open(trigger.getAttribute('src'), trigger.getAttribute('alt')); return; }
            if (e.target === lb || e.target === lbClose) close();
        });
        // Keyboard-activate the zoom triggers (they are role="button" tabindex="0").
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !lb.hidden) { close(); return; }
            if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
                var trigger = e.target.closest && e.target.closest('[data-zoom]');
                if (trigger) { e.preventDefault(); open(trigger.getAttribute('src'), trigger.getAttribute('alt')); }
            }
            // Trap Tab inside the open lightbox (only the close button is focusable).
            if (e.key === 'Tab' && !lb.hidden) { e.preventDefault(); lbClose.focus(); }
        });
    }

    /* ============================================================
       3. EXEMPLAR CORPUS (client-side mirror)
       The Curator agent references these by id and the show_exhibit
       tool names which id + which phrase to highlight. Keeping a
       client copy lets the panel render instantly without shipping
       the full corpus back over the wire each turn.
       Excerpts are ORIGINAL, anonymised approach-illustrations — not
       verbatim student work.
       ============================================================ */
    var EXEMPLARS = {
        'essay-euthanasia': {
            form: 'Essay (the official A-grade exemplar)',
            question: 'Is euthanasia ever the courageous choice, or a failure of endurance?',
            excerpt: 'Euthanasia can be active or passive, voluntary or involuntary — so the first task is to say precisely which case is in question. Aristotle held that every virtue sits between two extremes: courage lies between cowardice and foolhardiness. You could call euthanasia the courageous act — facing death, freeing loved ones from a heavy burden. On the other hand, it could be cowardice: lacking endurance and violating the sanctity of life. Applied to a case this sensitive, Virtue Ethics appears too vague to settle the matter — though perhaps a person of true wisdom would simply know the right course.',
            note: 'How it works: define the issue precisely → explain the philosopher fairly → argue the SAME principle both ways → reach a position that follows from the analysis. That both-ways move is the critical analysis most students skip.'
        },
        'parable-freewill': {
            form: 'Parable / allegory',
            question: 'Are we free to choose who we become, or determined by our past?',
            excerpt: 'A story is invented: an alcoholic father has two sons. One becomes an alcoholic too; the other never touches a drink. Asked why, each says the same thing — "with a father like that, what choice did I have?" The narrative lets three positions argue without a single line of essay: free will (the sons chose), fatalism (their fate was sealed), and determinism (prior causes fixed each path). The story does the arguing; the reader feels the tension before any conclusion is stated.',
            note: 'How it works: design a story where each character embodies a different position. The plot becomes the argument. Risky and memorable — but it must still name the positions and weigh them, or it reads as fiction, not philosophy.'
        },
        'film-meaning': {
            form: 'Short film',
            question: 'Does a life need to be true to be meaningful?',
            excerpt: 'The study is built around the film Big Fish, whose hero tells fantastical versions of his own life. Scenes are used as evidence: the film keeps asking whether the embellished story is "truer" than the dull facts. The student maps this onto the philosophical question and argues a position — that meaning can survive a loosened grip on literal truth — using the plot as the worked example.',
            note: 'How it works: find a film whose story already wrestles with your question, then treat its scenes as evidence. Ambitious and vivid — the trap is letting it become a film review. It must keep returning to the philosophical claim.'
        },
        'poster-mind': {
            form: 'Illustrated poster',
            question: 'Is the mind completely physical?',
            excerpt: 'One image carries the whole argument: a head drawn half as glowing circuitry, half as a watercolour cloud of feeling. Three short labels do the rest. THE PHYSICALIST VIEW — the mind is just the brain. THE OBJECTION — but knowing every brain fact still doesn\'t tell you what red FEELS like. A POSITION — the mind may depend on the brain, yet the felt quality of experience resists a purely physical account.',
            note: 'How it works: boil the position to one sentence, let one strong image hold it, and trust white space. A poster can\'t hide a weak argument behind word count — so every word must be the clearest version of itself.'
        },
        'dialogue-knowledge': {
            form: 'Dialogue',
            question: 'Can we ever be certain of anything?',
            excerpt: 'Two voices argue across the page. DESCARTES: I can doubt my senses, even the world — but the very act of doubting proves I think, and so I am. From that one certainty I rebuild. HUME: And yet every idea you "rebuild" came from experience, which never gives certainty — only habit. You have never SEEN cause; you have only seen one thing follow another. The reader watches the disagreement sharpen rather than being told a conclusion.',
            note: 'How it works: pick two thinkers who genuinely clash, and let each give their strongest case. You prove you understand both positions by making each one persuasive — the Platonic method, 2,400 years old.'
        },
        'slides-religion': {
            form: 'Slide deck',
            question: 'Do we need religion to be moral?',
            excerpt: 'Built to be presented aloud: one idea per slide, one image each. Slide 1 — the question, stark. Slide 2 — the Euthyphro problem as a forked road. Slide 3 — Mill: morality can rest on consequences, no deity required. Slide 4 — the reply: shared ritual binds communities in ways reason alone may not. Final slide — the student\'s position, one line, earned by what came before.',
            note: 'How it works: design it, don\'t paste an essay onto slides. Each slide makes one move and one image makes it land. The spoken track carries the detail; the slides carry the shape.'
        },
        'letter-speech': {
            form: 'Letter to the editor',
            question: 'Should free speech be allowed regardless of who is harmed?',
            excerpt: 'Addressed to a real reader in a real voice. It grants the other side first — yes, free speech is the engine of every reform we cherish. Then it presses: Mill himself drew the line at harm, not offence. It argues that the harm principle, not comfort, is the right test — and writes directly to the reader who began by disagreeing, trying to move them one step.',
            note: 'How it works: persuasive and personal, but it still weighs the other side fairly. Picture the reader who disagrees and write to change their mind — rhetoric in service of reasoning, not instead of it.'
        }
    };

    var exhibitEl = document.getElementById('curatorExhibit');

    /* Render an exemplar into the panel, optionally flashing a highlighted phrase.
       `append` stacks a second card (so the Curator can show two exhibits to
       compare) instead of replacing the first. */
    function showExhibit(id, highlight, append) {
        if (!exhibitEl) return false;
        // `id` is AI/tool output — use a strict own-property check so values like
        // "__proto__"/"constructor" can't reach a prototype member and throw.
        if (!Object.prototype.hasOwnProperty.call(EXEMPLARS, id)) return false;
        var ex = EXEMPLARS[id];
        if (!ex || typeof ex.excerpt !== 'string') return false;

        var excerptHtml = esc(ex.excerpt);
        if (highlight) {
            // Highlight the first case-insensitive occurrence of the phrase.
            var idx = ex.excerpt.toLowerCase().indexOf(String(highlight).toLowerCase());
            if (idx !== -1) {
                var before = esc(ex.excerpt.slice(0, idx));
                var match = esc(ex.excerpt.slice(idx, idx + highlight.length));
                var after = esc(ex.excerpt.slice(idx + highlight.length));
                excerptHtml = before + '<mark class="flash">' + match + '</mark>' + after;
            }
        }

        var cardHtml =
            '<div class="exhibit-card">' +
            '<p class="exhibit-card__form">' + esc(ex.form) + '</p>' +
            '<p class="exhibit-card__q">' + esc(ex.question) + '</p>' +
            '<div class="exhibit-card__excerpt">' + excerptHtml + '</div>' +
            '<p class="exhibit-card__note">' + esc(ex.note) + '</p>' +
            '</div>';
        if (append) exhibitEl.insertAdjacentHTML('beforeend', cardHtml);
        else exhibitEl.innerHTML = cardHtml;

        var marks = exhibitEl.querySelectorAll('mark');
        var mark = marks.length ? marks[marks.length - 1] : null;
        if (mark) {
            mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // settle the flash to the calmer cobalt highlight after a beat
            setTimeout(function () { mark.classList.remove('flash'); }, 1600);
        } else {
            exhibitEl.scrollTop = 0;
        }
        return true;
    }

    /* ============================================================
       4. THE CURATOR CHAT (chat.js mode:'exemplars')
       ============================================================ */
    function wireCurator() {
        var stream = document.getElementById('curatorStream');
        var input = document.getElementById('curatorInput');
        var send = document.getElementById('curatorSend');
        if (!stream || !input || !send) return;

        var history = [];   // {role, content}
        var busy = false;

        function addMsg(role, text) {
            var wrap = document.createElement('div');
            wrap.className = 'cm cm--' + role;
            var who = document.createElement('div');
            who.className = 'cm__who';
            who.textContent = role === 'agent' ? 'The Curator' : (role === 'you' ? 'You' : '');
            var body = document.createElement('div');
            body.className = 'cm__body';
            body.textContent = text;
            if (who.textContent) wrap.appendChild(who);
            wrap.appendChild(body);
            stream.appendChild(wrap);
            stream.scrollTop = stream.scrollHeight;
            return wrap;
        }

        // Opening line
        addMsg('system', 'Ask me how anyone in this gallery did it — "how did someone do free will?", "show me a parable", "what makes a good question?" I\'ll bring the example up beside us.');

        function setBusy(b) {
            busy = b;
            send.disabled = b;
            input.disabled = b;
        }

        async function ask(text) {
            if (!text.trim() || busy) return;
            addMsg('you', text);
            history.push({ role: 'user', content: text });
            setBusy(true);

            var typing = addMsg('agent', 'Looking through the gallery…');

            try {
                var r = await fetch('/.netlify/functions/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'exemplars',
                        token: window.MarginaliaSession ? window.MarginaliaSession.token() : null,
                        message: text,
                        history: history.slice(0, -1).slice(-8)
                    })
                });
                if (r.status === 401 && window.MarginaliaSession) {
                    window.MarginaliaSession.expire();
                    return;
                }
                var data = await r.json();
                typing.remove();

                if (!r.ok) {
                    addMsg('agent', 'I can\'t reach the gallery desk just now — give it a moment and ask again.');
                } else {
                    var reply = data.reply || '';
                    if (reply) { addMsg('agent', reply); history.push({ role: 'assistant', content: reply }); }
                    // The agent drives the panel via show_exhibit tool calls,
                    // returned as data.exhibits = [{id, highlight}, ...].
                    if (Array.isArray(data.exhibits)) {
                        var shown = 0;
                        data.exhibits.forEach(function (ex) {
                            // First exhibit replaces the panel; any extras stack
                            // below it so a compare-two-exhibits turn shows both.
                            if (ex && ex.id && showExhibit(ex.id, ex.highlight, shown > 0)) shown++;
                        });
                    }
                }
            } catch (e) {
                typing.remove();
                addMsg('agent', 'Something interrupted us — check your connection and ask again.');
            } finally {
                setBusy(false);
                input.focus();
            }
        }

        send.addEventListener('click', function () {
            var t = input.value; input.value = ''; ask(t);
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                var t = input.value; input.value = ''; ask(t);
            }
        });

        // Expose for any inline triggers (e.g. a "show me" button later).
        window.marginaliaShowExhibit = showExhibit;
    }

    function init() {
        buildRail();
        wireLightbox();
        wireCurator();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
