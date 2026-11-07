---
name: glitch-hunt
description: "QA pass for subtle visual glitches in a running web app. Detect sidebar/header refreshing, chat box flicker or remounts, text flaps and layout jumps using Glitch Lab frame/React/DOM sensors. Use for flicker, flashing, jank, refreshing, blinking, jumping, unstable UI or a visual QA pass. Reports evidence and sensor limitations, not guaranteed root causes."
---

# Glitch hunt

Glitches last 50–300 ms and happen *between* the moments an agent looks at the page. Never try to judge flicker from screenshots or accessibility snapshots, and never conclude "no glitches found" from them. Use `glitch_hunt`: it samples frames and bounded React/DOM sensor events. Treat attribution as a lead to verify, not proof of root cause.

## Before the first run

- Run `glitch_lab_doctor`. If it fails, request download permission before `install=true`.
- Obtain explicit permission for interactions in a disposable test environment before `interact=true`. Login, typing, submission and server writes additionally need `allowWrites=true`; never infer that permission. Repeats can repeat writes. Use loads/idle modes for observation; page scripts and GET endpoints may still have side effects.
- Always use a new output directory. Failed/incomplete runs are errors, not clean results.
- Ask for the URL of a **staging or production-like build** and a test login. Dev servers (`next dev`) double-render and hot-reload, which creates false glitches and hides real ones. Production builds work but show minified component names ("Xe" instead of "Sidebar"). A staging build with readable names is ideal.
- For logged-in apps, use a matrix config with a `login` block and an authenticated-only positive assertion (see the usability skill's `assets/matrix.web.example.json` and package README) and pass `cell=`. For public pages, `url=` is enough.

## The pass (in this order)

1. **Navigation**: `glitch_hunt` with `mode=nav` and `url=<main app page>` (or `cell=`). It finds the sidebar/header links itself and walks page to page. If it picks the wrong links, pass `items="Chat,Notes,Research,…"` with the visible link texts. This catches sidebars, headers and shells that rebuild or blink on every navigation.
2. **Idle watch** on pages with live data: `mode=idle` on the chat page and any dashboard. Nobody touches the page, so anything that blinks, rebuilds or re-renders repeatedly is the app refreshing itself (polling, timers, websocket updates). This is where "the chat box flickers" usually shows up.
3. **Key interaction**: `mode=journey` with the chat journey (open chat, type, send, wait for the reply), plus any other flow the user complains about. Mask expected streaming regions explicitly; don't assume every streaming effect is filtered.
4. **Other devices**: repeat step 1 with a mobile persona or `viewport=android`. Mobile layouts often have their own glitches.
5. **Evidence run**: repeat whichever run found the most with `paint=true`. It adds frames where repainted areas show green, which is the most convincing evidence for developers.

The defaults are 2 runs per scenario and a 4× slower CPU. Use `repeat=3` when results look inconsistent, and `cpu=6` if nothing shows but the user can see glitches on their own machine.

## Reading the results

The tool returns a ranked summary plus the strongest evidence images. For each HIGH or MEDIUM finding, open its evidence images before writing anything.

- **"X is thrown away and rebuilt"** with the note "looks the same before and after": a persistent piece of UI (sidebar, header, chat box) is being destroyed and recreated. This is the most common root cause of "refreshing" complaints. If the note says "its area changed", it's usually expected page content and low priority.
- **"X area blinks for N ms"**: a visible flash. Anything ≥100 ms on a main area is noticeable.
- **"X re-renders N×"** with "why it rendered": wasted work. On its own it's invisible, but it matters when it lines up with a blink or with slowness.
- **"text changes and changes back"**: wrong or empty content flashes, for example "120 → … → 120" or messages → empty → messages.
- **"right after: GET /api/…"**: the network response that triggered it. This is a big hint for developers.
- **"seen … 2/2 runs"**: it repeats. Findings seen in only 1 of N runs are probably noise unless the user reported them.
- **Framework internals** (Next.js routers, boundaries) are ranked low. Mention them only if nothing else explains a blink.

## Writing it up

One finding per root cause, not per screen. Merge "Sidebar is rebuilt" and "Sidebar area blinks" into a single finding.

For each finding:
- **What the user sees**, in plain words, and on which pages or devices.
- **How often**: every navigation, while idle every N seconds, or only after a specific action.
- **Evidence**: the before/after image and the repaint frames (`read` the PNG paths from the summary).
- **Likely cause**, in one line, using the component name, the "why it rendered" reason and the triggering request. For example: "Sidebar is created inside each page instead of the shared layout", "ChatBox component is defined inside ChatPage, so it's a new component on every render", "messages are cleared before refetching", "credits are reset to empty on every route change".
- **Severity**: HIGH when it's in the main layout on every navigation, rebuilds something the user is typing in, or flashes wrong data.

Finish with `ux_report` (`runDir` = the output folder) for a shareable HTML report.

You may read the source code **after** a finding is established, to confirm the cause and point to the file. The detection itself stays black-box.

## Honesty

- If `React sensor: no React detected`, only the visual and DOM sensors ran. Say so, and don't invent component names.
- If a run errored (login failed, links not found), report that rather than "no glitches".
- A clean run means no glitches were detected under these conditions, not that none exist. State the pages, devices and runs covered.
