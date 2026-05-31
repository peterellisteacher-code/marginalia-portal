/* ============================================================
   glossary.js — define-on-demand term popovers (Marginalia)
   ------------------------------------------------------------
   FIXES the "tooltip appears in the top-left corner" bug.

   The site uses the native HTML Popover API. Once the stylesheet
   sets `margin: 0` on `[popover]`, the browser's default
   `inset: 0; margin: auto` centring is gone and the popover pins
   to the top-left of the viewport with no anchor. This module
   positions each popover next to the term that opened it, and
   adds gentle hover-intent + keyboard/focus support so it behaves
   like the glossary tooltip students expect.

   Accessibility: kept WCAG 2.2 SC 1.4.13 (Content on Hover) —
   the popover is HOVERABLE (pointer can move onto it without it
   vanishing), DISMISSIBLE (Esc / click-away via popover="auto"),
   and PERSISTENT (stays until dismissed). `aria-describedby`
   means screen-reader users always hear the definition.

   Trigger contract (already in the HTML):
       <button class="term" aria-describedby="def-x">word</button>
       <div id="def-x" popover="auto">definition…</div>

   - `.term` elements        → open on hover, focus, AND click.
   - other elements that carry aria-describedby → a [popover]
     (e.g. the question-bank filter chips, which also FILTER on
     click) → open on hover/focus only, so their real click action
     is never hijacked by the definition.
   ============================================================ */
(function () {
    'use strict';

    var OPEN_DELAY = 90;    // ms of hover-intent before showing
    var CLOSE_DELAY = 200;  // ms grace so the pointer can travel onto the popover
    var GAP = 8;            // px between the term and its popover

    // Feature test. If the Popover API is missing we leave the markup alone:
    // `aria-describedby` still exposes the definition to assistive tech.
    if (typeof document.createElement('div').showPopover !== 'function') return;

    function popoverFor(trigger) {
        // aria-describedby may legally be a space-separated ID list, so resolve
        // the first referenced element that is actually a popover.
        var ref = trigger.getAttribute('aria-describedby') ||
                  trigger.getAttribute('popovertarget') || '';
        var ids = ref.split(/\s+/);
        for (var i = 0; i < ids.length; i++) {
            var el = ids[i] && document.getElementById(ids[i]);
            if (el && el.hasAttribute('popover')) return el;
        }
        return null;
    }

    function isOpen(pop) {
        try { return pop.matches(':popover-open'); }
        catch (e) { return !!pop.__open; }
    }

    /* Place `pop` next to `trigger`: below by preference, flipped above when
       there is no room; left-aligned with the term; clamped to the viewport. */
    function position(pop, trigger) {
        if (!trigger) return;
        var tr = trigger.getBoundingClientRect();
        var pr = pop.getBoundingClientRect();
        var vw = window.innerWidth || document.documentElement.clientWidth || 0;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;

        var top = tr.bottom + GAP;
        // Flip above the term only when we know the viewport height and there
        // is no room below but room above.
        if (vh && top + pr.height > vh - GAP && tr.top - GAP - pr.height >= GAP) {
            top = tr.top - GAP - pr.height;
        }
        if (vh) top = Math.max(GAP, Math.min(top, vh - pr.height - GAP));

        // Left-align with the term; clamp into the viewport when its width is known.
        var left = tr.left;
        if (vw) left = Math.max(GAP, Math.min(left, vw - pr.width - GAP));

        pop.style.position = 'fixed';
        pop.style.margin = '0';
        pop.style.top = top + 'px';
        pop.style.left = left + 'px';
        pop.style.right = 'auto';
        pop.style.bottom = 'auto';
    }

    function show(pop, trigger) {
        if (!pop) return;
        pop.__invoker = trigger;
        if (!isOpen(pop)) {
            try { pop.showPopover(); } catch (e) { return; }
        }
        // Set the fallback flag AFTER showPopover, so the :popover-open check
        // above is honoured in browsers that support it.
        pop.__open = true;
        // showPopover() paints at the UA default spot; reposition before the
        // browser's next paint so there is no visible jump.
        position(pop, trigger);
    }

    function hide(pop) {
        if (!pop) return;
        pop.__open = false;
        if (isOpen(pop)) { try { pop.hidePopover(); } catch (e) {} }
    }

    function wire(trigger) {
        var pop = popoverFor(trigger);
        if (!pop || trigger.__glossaryWired) return;
        trigger.__glossaryWired = true;

        var clickToToggle = trigger.classList.contains('term');

        // We fully control opening from JS, so drop the native popovertarget:
        // it would double-toggle on click, and on the filter chips it would
        // pop a definition every time the student tries to filter.
        if (trigger.hasAttribute('popovertarget')) {
            trigger.removeAttribute('popovertarget');
            trigger.removeAttribute('popovertargetaction');
        }

        // Keep the fallback __open flag accurate even when the popover is
        // light-dismissed (Esc / click-away) without going through hide().
        // Bound once per popover.
        if (!pop.__toggleBound) {
            pop.__toggleBound = true;
            pop.addEventListener('toggle', function (e) { pop.__open = (e.newState === 'open'); });
        }

        var openTimer = null, closeTimer = null;

        function scheduleOpen() {
            clearTimeout(closeTimer);
            clearTimeout(openTimer);
            openTimer = setTimeout(function () { show(pop, trigger); }, OPEN_DELAY);
        }
        function scheduleClose() {
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
            closeTimer = setTimeout(function () { hide(pop); }, CLOSE_DELAY);
        }

        trigger.addEventListener('mouseenter', scheduleOpen);
        trigger.addEventListener('mouseleave', scheduleClose);
        trigger.addEventListener('focus', function () { show(pop, trigger); });
        trigger.addEventListener('blur', scheduleClose);

        // Hoverable (WCAG 1.4.13): keep open while the pointer is on the popover.
        pop.addEventListener('mouseenter', function () { clearTimeout(closeTimer); });
        pop.addEventListener('mouseleave', scheduleClose);

        if (clickToToggle) {
            trigger.addEventListener('click', function (e) {
                e.preventDefault();
                if (isOpen(pop)) hide(pop); else show(pop, trigger);
            });
        }
    }

    /* Keep open popovers glued to their term as the page scrolls / resizes.
       Throttled to one pass per animation frame. */
    var repositionTicking = false;
    function reposition() {
        if (repositionTicking) return;
        repositionTicking = true;
        requestAnimationFrame(function () {
            repositionTicking = false;
            var pops = document.querySelectorAll('[popover]');
            for (var i = 0; i < pops.length; i++) {
                var p = pops[i];
                if (p.__invoker && isOpen(p)) position(p, p.__invoker);
            }
        });
    }

    function init() {
        var triggers = document.querySelectorAll(
            '.term[aria-describedby], [data-term][aria-describedby], [aria-describedby][popovertarget]'
        );
        for (var i = 0; i < triggers.length; i++) {
            if (popoverFor(triggers[i])) wire(triggers[i]);
        }
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
