# Visual Affordance & Comprehension Guide

How to judge, from screenshots, whether users can tell what's clickable and what it does.

## Contents
1. What makes something look clickable
2. The five failure types (with what to recommend)
3. Comprehension: does the user know what the control will do?
4. Layout & placement: will they find it?
5. AI-platform-specific surfaces (chat, notes, research, widgets)
6. Persona lenses
7. First-click test protocol

---

## 1. What makes something look clickable

Users read clickability from a few visual cues, roughly in this order of strength:
- **Filled shape with contrasting background** and short verb label → button.
- **Outline/border with rounded corners**, padding, short label → secondary button.
- **Colored (usually blue) or underlined text** → link.
- **Chevron `›`, arrow, or "…" at the edge of a row/card** → opens something.
- **Card with shadow and hover lift** → the whole card is clickable (weak cue; ambiguous).
- **Standard icons in toolbars** (pencil, trash, share, copy, paperclip, mic, send) → action, *if* the user knows the icon.
- **Cursor change on desktop** (only after hovering, so it doesn't help discovery, and is absent on mobile).

A control is clear when it has at least one strong cue *and* nothing nearby that isn't clickable shares that cue.

## 2. The five failure types

| Type | What the user does | Typical cause | Recommend |
|---|---|---|---|
| **Fake affordance** (red) | Taps something repeatedly; "it's broken" | Status chips/tags/badges styled like buttons; headings in brand color; decorative icons in circles; non-clickable cards with shadow | Flat, low-emphasis style for non-interactive elements; brand-filled style reserved for actions; remove hover/shadow from static cards |
| **Hidden affordance** (orange) | Never discovers the feature | Clickable plain text, whole-row clicks with no chevron, actions only on hover, swipe-only actions | Visible button/link styling; chevrons on clickable rows; always-visible actions on touch devices |
| **Mystery icon** (purple) | Guesses, or avoids it | Icon-only buttons (sparkles, wand, brain, bolt, graph) for AI-specific actions with no label | Icon + text label for anything that isn't universal; tooltip isn't enough on mobile |
| **Tiny target** (yellow) | Misses, hits neighbor | Small icons in dense toolbars, close "×" in corners | ≥44×44px on touch, ≥24×24px desktop, 8px spacing |
| **Dead click** (probe) | Taps real control, nothing visible happens | No pending state, action happens off-screen, slow request with no spinner, disabled but looks enabled | Immediate pressed state + in-button spinner; toast or inline confirmation; visibly disabled style with reason |

Also check:
- **Primary vs secondary**: one clearly dominant primary action per view. Two filled buttons side by side = user doesn't know which.
- **Disabled look-alikes**: grey text that is actually clickable, or enabled-looking buttons that do nothing until a hidden condition is met.
- **Duplicate labels** going to different places ("Start" in header vs "Start" on card).

## 3. Comprehension: does the user know what it will do?

Ask for each control: *before pressing, can this persona predict the result?*
- Labels are **verb + object** in the user's words: "Save as note", "Ask the visa agent", "Upload tax form". Avoid "Process", "Generate", "Run", "Submit", "Go", "Continue" without context.
- Avoid platform jargon: agent, workspace, knowledge base, context, token, prompt, widget, tenant. A patient says "ask a question", a student says "my documents".
- Consequences are clear: will it send, share, publish, charge, or delete? Is it reversible?
- Where does the result go? After "Save", can the user see where it was saved?

## 4. Layout & placement: will they find it?

- The action sits where the eye already is: next to the thing it acts on, or at the end of the reading path (bottom-right of a form, below chat input).
- Consistent placement across screens and partners. Same action, same position.
- Nothing essential below the fold on mobile without a cue to scroll.
- Navigation labels match the persona's tasks, not the product's modules ("My applications", not "Workflows").
- Partner branding doesn't displace core controls (large logos pushing nav off-screen on mobile).

## 5. AI-platform-specific surfaces

**Chat**
- Obvious input and send; send is enabled only when there's text; Enter behavior is predictable.
- Which agent am I talking to? Name/avatar visible; switching agents is clear and says what changes.
- Response states: thinking indicator within ~300ms, streaming visible, stop button while generating, retry on failure, clear error when the agent fails. Silent failure is S1/S2.
- Message actions (copy, save to note, regenerate, feedback) labeled or at least recognizable; not hidden on hover on touch.
- Suggested prompts look tappable and read like things this persona would ask.

**Notes / documents**
- "Save to note" from chat shows where the note went and a link to open it.
- Autosave state visible ("Saved" / "Saving…"); no ambiguous "Save" button when autosave exists.

**Research**
- Long tasks show progress, can run in the background, and notify on completion. Sources look clickable and are.

**Data & widgets**
- Each widget has a title saying what it shows, units, and time range; loading and empty states say what's happening ("No tax documents yet: upload one"); a failing widget doesn't blank the dashboard.
- Charts: clickable elements (legends, bars) either work or don't look interactive.

## 6. Persona lenses

Apply the lens of the persona you're simulating; note when a finding affects one persona more than others.

- **Teen student (≈15, mobile-first)**: skims, taps fast, expects app-like patterns (bottom nav, big buttons), low patience for text walls, may not know admissions jargon (SOP, LOR, transcript). Fake affordances and tiny targets hurt most.
- **Migrating student (≈25, second-language English, anxious about deadlines)**: reads carefully but literally, relies on clear labels and dates, needs confidence that uploads/submissions worked, may use translation. Idioms and vague labels hurt most.
- **Financial analyst (desktop, power user)**: wants density, keyboard, exports, precise numbers with units, and doesn't tolerate waiting. Hidden bulk actions, slow widgets and ambiguous totals hurt most.
- **Patient (any age, possibly unwell, low vision or low literacy)**: needs calm, plain language, large text, reassurance about privacy, clear "this isn't a doctor / get urgent help" paths. Jargon, clutter, silent failures and anything suggesting data is shared hurt most.

## 7. First-click test protocol

For each journey step, before looking at what the script did:
1. Look at the screenshot as the persona, with their task in mind.
2. Write where you'd click first and why (element + reason).
3. Compare with the correct control. If different, record a comprehension/placement finding with both locations marked.
4. If you'd hesitate between two or more options, that's friction even if the right one wins.

First-click success correlates strongly with task success. A wrong first click on a primary task is S2.
