/* ============================================================
   youtube.js — lazy, privacy-friendly YouTube facades (Marginalia)
   ------------------------------------------------------------
   Turns any  <button class="yt" data-id="VIDEOID" data-title="…">
   into a click-to-play thumbnail. Nothing loads from YouTube until
   the student presses play, and playback uses youtube-nocookie.com
   so no tracking cookie is set on page view.

   - Thumbnail comes from i.ytimg.com (no cookie).
   - The facade is a real <button>, so it is keyboard-operable and
     announced; the iframe inherits the data-title as its name
     (WCAG 4.1.2).
   - Pre-validate every data-id with the YouTube oEmbed endpoint
     before shipping so no facade ever points at a dead video.
   ============================================================ */
(function () {
    'use strict';

    function thumbUrl(id) {
        return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    }

    function activate(el, id, title) {
        var iframe = document.createElement('iframe');
        iframe.className = 'yt-lite__frame';
        iframe.src = 'https://www.youtube-nocookie.com/embed/' + id +
            '?autoplay=1&rel=0&modestbranding=1';
        iframe.title = title;
        iframe.setAttribute('allow',
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        iframe.allowFullscreen = true;
        el.replaceWith(iframe);
        // Move focus into the player so keyboard users land on the video.
        try { iframe.focus(); } catch (e) {}
    }

    function build(el) {
        if (el.__ytWired) return;
        var id = el.getAttribute('data-id');
        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
        el.__ytWired = true;

        var title = el.getAttribute('data-title') || 'Educational video';
        el.classList.add('yt-lite');
        el.style.backgroundImage = "url('" + thumbUrl(id) + "')";
        if (!el.getAttribute('aria-label')) {
            el.setAttribute('aria-label', 'Play video: ' + title);
        }
        if (!el.querySelector('.yt-lite__play')) {
            var play = document.createElement('span');
            play.className = 'yt-lite__play';
            play.setAttribute('aria-hidden', 'true');
            el.appendChild(play);
        }
        el.addEventListener('click', function () { activate(el, id, title); });
    }

    function init() {
        var els = document.querySelectorAll('.yt[data-id]');
        for (var i = 0; i < els.length; i++) build(els[i]);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose for pages that inject video facades after load (e.g. the lab).
    window.marginaliaYouTube = { init: init, build: build };
})();
