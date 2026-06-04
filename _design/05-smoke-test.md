# Post-deploy smoke test — chamber + login

A quick (~10 min) manual pass to run after a Netlify deploy, focused on the two
big recent changes: the **whole-site login gate** and the **chamber** (chat,
persistence, and the cached readings packs). Tick each box; if one fails, the
note says where to look.

## Prerequisites (one-time, check in Netlify env)
- `SESSION_SECRET` set (login tokens fail in prod without it).
- `OPENROUTER_API_KEY` set (chat replies).
- `NETLIFY_BLOBS_TOKEN` + `BLOBS_SITE_ID` set (signed-in portal save/load).
- `YOUTUBE_API_KEY` optional (only affects the video tool).
- Use a private/incognito window so you start logged out. Have one student's
  name + password ready.

## A. Login / access gate
1. [ ] **Logged-out redirect.** Open `…/chamber.html` directly. → You are bounced to the login page (`index.html`). Repeat for `bank.html`, `lab.html`, `exemplars.html`, `resources.html`, `drafting.html`, `explainer.html`, `portal.html`. *(If a page does NOT redirect, it's missing `shared/gate.js` in its `<head>`.)*
2. [ ] **Public pages stay open.** `index.html` and a made-up URL (→ `404.html`) load without redirect.
3. [ ] **Login works.** Click a name, enter the surname password → you land on the portal. *(Fail → check `SESSION_SECRET` and the `auth` function logs.)*
4. [ ] **Millie's new password.** Log in as **Millicent** with `gilbert` → works. `gilbert-rugless` → "Wrong password." Wrong password for anyone → inline error, no crash.
5. [ ] **Return-to-deep-link.** Logged out, open `…/chamber.html?pack=stage1_reason_passion`. → bounced to login → after logging in you land back on the chamber with **reason & instinct** preselected.
6. [ ] **Session persists in tab.** After login, click around the nav (bank → lab → readings) → no repeated login prompts.
7. [ ] **Logout re-locks.** Portal → "Log out" → then open `chamber.html` → bounced to login again.
8. [ ] *(Optional)* **Bad token bounces.** In DevTools, edit `sessionStorage['marginalia.session']` to garbage, load a protected page → bounced to login (the `auth` "verify" check catches it).

## B. Chamber — chat, packs, persistence
9. [ ] **Basic reply.** In the chamber, send "I want to do mine on gut feeling vs reasoned thinking." → the agent replies with a sharpening question (2–4 sentences), does not write an essay.
10. [ ] **New pack loads + is quoted.** Select the **reason & instinct** chip, ask "What did Plato and Aristotle say about this?" → the agent quotes a cached passage (e.g. the *Phaedrus* charioteer, or Aristotle's "we become just by doing just actions"). *(Fail → confirm `data/packs/stage1_reason_passion.txt` deployed and `stage1_reason_passion` is a valid pack.)*
11. [ ] **Virtue pack Aristotle.** Select **virtue / compassion**, ask "What does Aristotle say about friendship?" → agent can reach the "another himself" / "no one would choose to live without friends" material.
12. [ ] **Video de-emphasis.** Ask a broad question → the agent leans on the readings/chat rather than pushing a YouTube video first.
13. [ ] **Chat persists across sessions.** Send 2–3 messages, then **refresh** → the conversation is still there. Edit the working question, refresh → it persists too.
14. [ ] **New chat.** Click **New chat** → transcript clears; working question + pins remain.
15. [ ] **Readings deep-link.** From `resources.html`, click "Discuss in chamber →" on a *Reason & instinct* card → chamber opens with that pack selected.

## C. Other agents (quick)
16. [ ] **Explain the task** (`explainer.html`) → replies in plain language, won't write the essay, will put the task sheet in plainer words if asked.
17. [ ] **Showroom** (`exemplars.html`) → Curator replies and brings up an exhibit panel when it references one.

## D. Caching sanity (optional, teacher-level)
18. [ ] In Netlify function logs, send two chamber turns on the same pack within a few minutes and look at the `chat.usage` log lines: the second turn should show `cached_tokens` > 0 (a cache read). Confirms the readings packs are caching.

## If something fails
- Redirect loops or no redirect → `shared/gate.js` inclusion / `auth` function.
- "Storage error" in portal → Blobs env vars.
- Chat 402/503 → OpenRouter key / spend cap.
- Agent ignores a pack → pack filename vs the `data-pack` id; check it's in `VALID_PACKS` (portal) and present in `data/packs/`.
