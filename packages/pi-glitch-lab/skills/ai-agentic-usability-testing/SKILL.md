---
name: ai-agentic-usability-testing
description: "Browser UI/UX and deterministic UAT testing with Glitch Lab. Inventory rendered controls, explore authorized menu/tab/dialog/navigation states, test scripted acceptance criteria and report evidence/coverage. For dashboards and web apps. No AI calls in the execution scripts. Not exhaustive accessibility or native-device certification."
---

# UI/UX and UAT with Glitch Lab

## Authorization first

Use approved disposable environments and test accounts. Loading a page can itself change data. Never claim this is a read-only sandbox or that reloading rolls back server state.

- Start `ux_affordance_scan` without `probeClicks`: observation only.
- Before any click exploration or navigation glitch pass, obtain explicit user permission and set `interact=true`.
- Login, typing, selects/checkboxes, submit/Enter and writes require separate permission and `allowWrites=true` as well.
- Never infer authorization from tool availability or from a request for a report. In headless mode the caller supplies permission flags only after operator approval.
- Run `glitch_lab_doctor` to check the browser. Install Chromium only when the user authorizes the download.

## Configure

Copy `assets/matrix.web.example.json` into `.ux/matrix.json`. Replace URL, target selectors and expected outcomes with the actual approved contract. Ask for missing business criteria; do not invent them.

Use exact role/name or label locators; explicit selectors can identify controls with duplicate names. Missing/ambiguous targets fail. For login, use environment-variable credentials plus `login.authenticated` (an authenticated-only visible selector) and/or an exact non-root `login.waitFor` pathname. No login state is saved to disk. Keep `.ux/` ignored/private, configure masks, and review evidence for sensitive data before sharing.

Optional education/finance personas in `assets/default-personas.md` and `matrix.default.json` are examples for those domains, not defaults to impose on unrelated apps. Their placeholders require calibration and updated positive authentication checks.

## Pass 1 — inventory

Call `ux_affordance_scan` with URL or config/cell. Read annotated screenshots and saved items:
- labels, focusability, disabled/expanded/selected/checked state;
- small, unlabeled or covered targets and horizontal overflow;
- fake/hidden-button visual candidates, not proven failures;
- scroll bounds and inaccessible/unexplored content.

## Pass 2 — bounded interaction coverage

After approval, call `ux_affordance_scan` with `probeClicks=true, interact=true`. Set page/state/action/depth/time bounds appropriate to the approved area.

The explorer resets/replays parent states, discovers revealed menus/tabs/dialogs and records before/after evidence. It skips automatic input values and obvious submit/destructive controls. HTTP write blocking without allowWrites is defense in depth, not proof of no side effects. Repeated interactions can repeat writes if authorized.

Distinguish responded, no-observable-response, error, blocked and skipped. A network request is not acceptance. No visible response may be valid for clipboard/hover controls or may need a longer observation window. Report limit hits and unvisited states; never claim every control works.

## Pass 3 — scripted UAT

Run `ux_journeys` for explicit business acceptance:
1. Assert the expected loaded screen or authenticated user.
2. Execute approved actions.
3. Assert text/URL/visibility/value/checked/enabled/count/attribute outcomes.
4. For an authorized persistence test, reload and assert the saved value.

Use a keyboard `press` step for Tab/arrow/Enter tests. Fill/select/check/save require writes permission. Optional steps must not hide a required outcome. Negative persona/content checks belong after a positive loaded-state assertion; a login page is not proof that tenant gating works.

Required failures, missing/empty journeys and missing baselines fail. Do not convert a tool error into a pass. A new baseline needs a new directory; never overwrite historical evidence. `measureResponse` must observe output and stable completion before its timeout.

## Glitch pass

Use `glitch_hunt` for flicker/remount/layout-shift concerns; read the glitch-hunt skill. Prefer production-like builds and repeated evidence. React sensor availability, sampling and minification limit attribution.

## Report

Use `ux_report` with run directory and optional written findings JSON. Include:
- approved target, persona/device, scope and actions;
- discovered/exercised control-state pairs, visited states, bounds and skipped/blocked reasons;
- UAT criteria passed/failed and baseline provenance;
- evidence paths and observed timing;
- UX findings in plain language with recommendations;
- gaps: iframe/shadow/virtualized/native/keyboard-only or other untested states.

Keep execution evidence separate from interpretation. Simulated personas are not real-user usability research. No application code changes or extra journeys without authorization.
