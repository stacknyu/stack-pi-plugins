> **Phase 2.** Test direct platform users first (cells without a partner). Use this guide when the user is ready to test partner / white-label experiences.

# Persona × Partner Test Matrix

A white-label, multi-vertical platform has too many combinations to test all of them. Choose cells that expose the most risk per run.

## 1. Dimensions

- **Vertical / persona tag**: education, migration, finance, health… Each loads different agents, dashboards, widgets, knowledge bases.
- **Partner (tenant)**: branding (logo, name, colors, fonts), enabled agents, knowledge base content, custom domain/URL, possibly custom copy.
- **Device & network**: mobile/desktop; fast/slow.
- **User state**: brand-new (empty data), active (lots of data), returning after a change.
- **Role**: end user vs partner admin (if partners configure things in-app).

## 2. Picking cells

1. **One cell per vertical, on its most typical partner.** This is the core usability study.
2. **Stress partners** (reuse one persona):
   - Loud branding: dark or neon primary color, long name (30+ characters), wide logo, custom font.
   - Minimal config: few agents enabled, empty knowledge base, default branding.
   - Default / platform-owned experience.
3. **Cross-vertical partner**, if a partner serves more than one vertical: check that tags still gate correctly.
4. **Edge states**: new user with no data; user on slow 3G mobile; non-English locale if supported.
5. **Pairwise, not exhaustive**: make sure every persona appears at least once on mobile and once on desktop, and every partner type is hit by at least two personas. Don't multiply everything by everything.

A good first matrix is 6–10 cells. Grow it after the first report, targeting where problems clustered.

## 3. Tenant correctness checks (per cell)

Write these as `expectText` / `expectNoText` steps and verify visually.

**Branding**
- Partner logo, name and colors on: login/signup, main nav, empty states, error pages, loading screens, emails or PDFs previewed in-app, browser tab title and favicon.
- No flash of platform or another partner's branding during load (look at the first screenshots after navigation and after login redirects).
- Long names and wide logos don't break the header on mobile.

**Brand color side effects** (the most common white-label usability bug)
- Primary buttons still contrast with their text and with the page (≥4.5:1 text, ≥3:1 for the button shape against background).
- Primary and secondary buttons still look different.
- Links are still distinguishable from body text.
- Status colors (success/warning/error) aren't confused with the brand color (e.g. a red-branded partner making every button look like "delete").

**Gating**
- Only agents enabled by this partner *and* matching this persona's tag are visible, in pickers, suggestions, search, and deep links.
- Knowledge base / content from this partner only. Search results must not surface other partners' documents.
- Dashboards and widgets match the vertical (no tax widget for a student).
- Direct URL test: open a known URL of another vertical's page or another partner's agent. Expect a friendly "not available" page, not the content, and not a crash.
- **Any leak across partners or verticals is S1**, especially with health or financial data.

**Graceful gaps**
- Partner disabled an agent the persona's journey expects: is there a clear alternative, or a dead end?
- Empty knowledge base: does the agent say it has no partner content, or does it pretend?
- Unconfigured widget: hidden cleanly, or a broken/blank box?

## 4. Writing the forbidden list

For each cell, build `expectNoText` from:
- Names of other partners (at least two).
- Agent names from other verticals ("Tax agent", "Health assistant", "Visa agent").
- Platform brand name, if partners should be fully white-labeled.
- Obvious error markers: "undefined", "null", "NaN", "Error:", "Something went wrong", "[object Object]", raw translation keys like `dashboard.title`.
