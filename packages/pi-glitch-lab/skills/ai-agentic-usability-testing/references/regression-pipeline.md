# From Audit to Regression Pipeline

"We push something and something else breaks" is a missing safety net, not a UX problem. The journeys written for the audit are the fastest way to build that net, because they already describe what users must be able to do in each persona × partner cell.

## 1. Golden journeys

- Pick 1–3 journeys per vertical that must never break (login → reach dashboard; start a chat with the right agent and get a reply; save a note; open the main widget).
- Add at least one cross-partner leak check per vertical (`expectNoText` with other partners' names and other verticals' agents).
- Keep journeys short (5–12 steps) and use visible text or roles for targets, not CSS classes, so they survive restyling.
- Mask dynamic regions in screenshots (AI replies, timestamps, avatars, counters) using `mask` in the cell config, so visual diffs only flag real layout changes.

## 2. Baseline and compare

```bash
# on a known-good build
# in Pi: ux_journeys baseline=".ux/baseline" with explicit interact/write permission
# Outside Pi, from the installed package folder, on an approved disposable environment:
node <pi-glitch-lab>/scripts/journey_runner.mjs --config .ux/matrix.json --all --interact --allow-writes --baseline .ux/baseline
# on every new build
node <pi-glitch-lab>/scripts/journey_runner.mjs --config .ux/matrix.json --all --interact --allow-writes --compare .ux/baseline --out .ux/runs/$BUILD_ID
node <pi-glitch-lab>/scripts/glitch_lab.mjs nav --config .ux/matrix.json --all --interact --allow-writes --repeat 2 --out .ux/runs/$BUILD_ID/glitch
node <pi-glitch-lab>/scripts/report.mjs .ux/runs/$BUILD_ID --out .ux/runs/$BUILD_ID/report.html --embed
```

The compare run exits with code 2 when a journey breaks, a leak appears, a step becomes much slower, or a screen changes visually. Intended design changes are reviewed and then captured into a NEW baseline directory. Existing baselines and run directories are never overwritten. Evidence may contain private data; do not commit it automatically.

## 3. Where to run it

Order of value:
1. **On every preview/staging deploy** (e.g. Vercel preview URL, staging after merge). Block promotion to production if it fails.
2. **Scheduled disposable staging runs**, to catch config and data drift. Do not automatically explore production or assume test accounts make arbitrary clicks safe.
3. **After partner onboarding or branding changes**: run that partner's cells.

Run locally or in an explicitly approved automation service; no GitHub Actions is required. Respect nonzero exit codes, protect private artifacts, and provide test-account passwords through environment variables referenced as `"env:VAR_NAME"`. Flags authorize only actions the operator has actually approved; they do not roll back writes.

## 4. Grow it deliberately

- Every S1/S2 bug that reaches users becomes a new step or journey, so it can't come back silently.
- Keep the whole suite under ~10 minutes; split by vertical if needed so failures point at an owner.
- Visual-diff flakiness usually means an unmasked dynamic area or an animation; fix the mask rather than raising the threshold.
- This complements, not replaces, unit/integration/API tests owned by engineering. Recommend the team adds contract tests for the persona-tag → agents/widgets gating logic, since that's where cross-connected features break.
