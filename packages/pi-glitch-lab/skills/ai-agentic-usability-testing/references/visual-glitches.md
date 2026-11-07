# Visual Glitches: What They Look Like and What to Write Down

Subtle glitches ("I opened a page and something else on the screen refreshed") erode trust even when nothing is technically broken. Users describe the app as "buggy", "unstable" or "cheap". `glitch_watch.mjs` finds candidates; this guide helps you judge and describe them.

## Contents
1. Glitch types
2. Judging: would a user notice?
3. Severity
4. How to write a glitch finding
5. Likely causes (for the developers' benefit)
6. Tips for running the watcher

---

## 1. Glitch types

| Type (script) | What the user sees | Common examples |
|---|---|---|
| **flicker** | Something blinks, flashes blank or to another state, then comes back, usually in under half a second | Sidebar/nav blinks when opening a page; widget flashes empty; avatar/logo reloads; button label switches and back; whole panel goes white for a frame |
| **remount** (DOM) | Same as flicker, but the element was fully destroyed and rebuilt, often losing scroll position, expanded sections or typed text | Chat list re-renders when a message arrives; notes list rebuilds after saving; sidebar rebuilds on each navigation |
| **text-flap** (DOM) | A number or text changes and changes back | Credits "120 → 0 → 120"; user name → "Guest" → name; "Loading…" → value → "Loading…" → value; price or index value blinking |
| **late-change** | Part of the page changes after it already looked finished; nothing the user did caused it | Widget refreshes itself 3 seconds after load; header re-renders when data arrives; a banner appears and pushes things; unrelated panel updates after clicking elsewhere |
| **layout-shift** | Content jumps position | Banner inserted at the top; image loads without reserved space; font swap; list grows above where the user is reading |

Also watch for these in screenshots and filmstrips (the script can't always label them):
- **Wrong-state flash**: logged-out header, empty state ("No notes yet") or zero values shown briefly before real data.
- **Theme/branding flash**: default colors or logo before the right ones.
- **Double loading**: skeleton → content → skeleton → content.
- **Focus/scroll jump**: page scrolls on its own, or the text cursor leaves the chat input after a reply arrives.
- **Streaming jank**: AI reply jumps, re-renders from the start, or the page auto-scrolls fighting the user who is scrolling up to read.

## 2. Judging: would a user notice?

Open the `*_glitch_NN.png` (before / glitch / after) and the filmstrip. Then ask:
- **Size and place**: is it in the user's focus (main content, the thing they just clicked, the chat input) or peripheral? Large or central = noticeable.
- **Duration**: under ~50 ms is rarely seen; 100–500 ms is clearly visible as a blink; longer is a visible wrong state.
- **Content change**: a blink to *wrong content* (zero balance, "Guest", empty list) is worse than a blink to blank.
- **Frequency**: on every page load or navigation (high), or once in a while.
- **Persona**: a senior user at 125% zoom reading carefully will notice a paragraph jumping; a fast mobile user will notice a blinking nav.

Discard: intentional animations (spinners, typing dots, progress bars; the script marks these `probablyIntentional`), real-time data updating as designed (a live index ticking; though check that it doesn't blink or jump), and AI text streaming in the reply area (masked by default).

## 3. Severity

- **S2**: wrong-state flash of important data (balance, name, results), a glitch on every navigation in the main layout (nav/sidebar/header), a remount that loses user input or scroll, or layout jumps that cause mis-taps.
- **S3**: visible blink/refresh in secondary areas, late self-refresh of a widget, small shifts.
- **S4**: barely perceptible, rare.
- Escalate to **S1** only if the glitch makes the user act on wrong information or lose work.

## 4. How to write a glitch finding

Plain language first, then evidence:
> **UX-014 · Sidebar blinks every time a page opens (all personas).** When opening Notes, Research or Dashboard, the left sidebar disappears for about 120 ms and reappears. It makes the app feel unstable, and on the senior persona's zoomed laptop it's very visible. *Evidence:* glitch images at 1.2 s on /notes, /research; DOM shows the sidebar is rebuilt (remount). *Recommendation:* the sidebar should persist across page changes; only the main content area should update.

Always include: where (screen, region, element name if known), when (on load / after which action / how long after), how long it's visible, which personas and devices, screenshot. Group identical glitches across screens into one pattern finding.

## 5. Likely causes (for the developers)

You aren't fixing code, but a one-line hint speeds up the fix:
- Element rebuilt on every navigation → layout/shell component re-created per page instead of persisting.
- Blink to empty/zero before data → data fetched on the client after first render, without keeping a placeholder or previous value.
- Widget refreshes after load → a second data fetch or a refresh timer; or a re-render when an unrelated piece of state (e.g. user profile, credits) arrives.
- Wrong-state flash (logged out / default theme) → session or theme resolved late in the browser.
- List rebuilt after save → whole list replaced instead of updated in place.
- Jumps → images, banners or fonts without reserved space.

## 6. Tips for running glitch_hunt

- Run against a **production-like build** (staging), not a local dev server. Dev mode re-renders things that production doesn't, and can hide others.
- Keep `repeat` at 2 or more. Real glitches repeat; one-offs may be network noise.
- Use `mode=idle` on live-data pages and `mode=journey` for actions. Many glitches happen on actions or timers, not on page loads.
- If a region changes legitimately (live ticker, rotating tips), add its selector to the cell `mask` in the config.
- `paint=true` adds repaint frames (green = repainted), the clearest evidence for developers.
- Setting the environment variable `GLITCH_DEBUG=1` saves every raw frame for close inspection.

## 7. Extra finding types from the React sensor

| Finding | Meaning | Typical cause |
|---|---|---|
| **X is thrown away and rebuilt** (looks the same before and after) | The component instance was destroyed and a new one created in the same place | Shared UI rendered inside each page instead of the layout; a component defined inside another component; a changing `key`; a conditional wrapper around the tree |
| **X is thrown away and rebuilt** (area changed) | Page content replaced | Usually expected on navigation; low priority |
| **X re-renders N×** (why: props / own state / parent re-rendered) | Wasted renders; invisible alone | New objects or functions passed as props on every render; state updated with equal values; a parent re-rendering on a timer |
| **"right after: GET /api/…"** | The response that preceded the glitch | Data fetched on the client and the UI reset while waiting |
