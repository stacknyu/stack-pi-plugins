# pi-glitch-lab

Deterministic browser UI/UX checks, interaction coverage and scripted UAT for [Pi](https://pi.dev). Uses Playwright/Chromium; scripts do not call AI. The agent interprets evidence, not invents acceptance criteria.

## Install

```sh
pi install npm:@stacknyu/pi-glitch-lab
# Later: pi update npm:@stacknyu/pi-glitch-lab
# Remove: pi remove npm:@stacknyu/pi-glitch-lab
```

Reload Pi. This package is independent of pi-flow and pi-check. Requires Pi (tested with 1.5.0), Node 22.19+, macOS/Linux and Chromium or Google Chrome. `/glitch-lab-doctor` checks the browser; `/glitch-lab-doctor install` explicitly downloads Playwright Chromium. No browser is downloaded on plugin load. Unpinned installs use Pi's native update notifications and this package's versioned changelog.

## Three passes

| Pass/tool | What it establishes |
|---|---|
| `ux_affordance_scan` | Observes rendered controls: labels, focusability, disabled/selected/expanded/checked states, target sizes, covering elements, overflow and visual affordance candidates. Scrolls the page and bounded nested containers. No clicks by default. |
| `ux_affordance_scan` with `probeClicks=true`, `interact=true` | Explores menu/tab/dialog/navigation states with bounded sequential clicks, replaying the initial state for independent probes. Records responded, no-observable-response, inconclusive (background noise), error, blocked and skipped outcomes, plus before/after screenshots. Does not automatically fill forms. |
| `ux_journeys` | Executes explicit acceptance steps/assertions, optionally establishing or comparing a visual baseline. Can test approved writes and persistence after reload. |
| `glitch_hunt` | Samples painted frames, React commits, DOM mutations, text flaps, layout shifts and network timing. Modes: nav, idle, loads, journey. Optional paint-flashing video. |
| `ux_report` | Builds a private HTML evidence report including coverage, limits, skipped actions, UAT failures and glitch findings. |

**A control responding is not proof of a correct business outcome.** A network request alone is not success. A control with no observed response is inconclusive: clipboard/hover actions and longer waits may need explicit journeys. Inventories and fake-button heuristics are candidates, not an accessibility certification.

Example requests:

- "Inventory controls on http://localhost:3000/dashboard without clicking."
- "On this disposable test app, explore the dashboard's controls. Report skipped controls and coverage limits."
- "Run the approved profile-save UAT journey, including a reload to verify persistence."
- "Find flicker while navigating the test dashboard."

## Authorization and data safety

**Use disposable test accounts and a staging/synthetic environment. Never point automatic exploration at production.** Loading a page itself can have side effects; this is not a sandbox or transaction rollback system.

- Observation is the default. Any click/typing/navigation exploration needs `interact=true` (`--interact` on CLI), reflecting explicit user authorization. Pi UI sessions additionally ask for confirmation.
- `allowWrites=true` (`--allow-writes`) additionally authorizes HTTP writes, login, typing, selecting/checking values and potentially submitting Enter presses. It requires `interact=true`. Replays/repeats can repeat server writes; there is no automatic cleanup or rollback.
- Without write authorization, non-GET/HEAD/OPTIONS requests and WebSockets are blocked. Unsafe-looking URL paths are also blocked. These guards cannot make unsafe GET endpoints or arbitrary application JavaScript harmless.
- Automatic exploration always skips obvious submit/destructive controls; authorized **scripted journeys** are required for those. Labels are not a security boundary.
- Document navigation is limited to the configured base origin plus explicit `allowedOrigins` on the cell. Writes and WebSockets can only reach those origins. HTTP redirects on document/write requests currently fail closed (use direct canonical targets and SPA-style login); chained redirect flows are not supported. Read-only subresources such as CDN assets may use other origins. Popups/dialogs/downloads encountered by the explorer are closed/dismissed/cancelled, but prior requests cannot be undone.
- Credentials use `env:VARIABLE` in login fields. Missing credentials or failed positive authentication checks fail the run. Set `login.authenticated` to a visible authenticated-only selector, and/or `login.waitFor` to an exact pathname other than `/`. Browser login state stays in memory; it is not cached in `.ux/auth` or written to disk.
- Evidence can contain application data. Review masks and keep `.ux/` private/ignored; do not publish reports automatically. Password inputs and `[data-private]` are useful mask defaults. Raw sensor/network evidence is not a secret-redaction system.

## Interaction coverage and limits

Default exploration limits per configured screen: 40 actual click attempts (including parent-state replays), 12 states, 5 URLs, depth 4, 120 seconds and 1000 ms observation per action. Tool options: `maxActions`, `maxStates`, `maxPages`, `maxDepth`, `seconds`, `observeMs`; CLI uses kebab-case flags. Each action has a bounded timeout. Reset/replay and evidence capture consume wall time; in-flight browser operations may finish after the exploration deadline. Unvisited states and limit hits are reported, not passed.

Every coverage file records control-state pairs, exercised/skipped/blocked results, states visited, pending states and limits. Same controls in different states count separately. A completed observation/exploration run means collection succeeded, **not** that the application passed UAT.

Coverage is limited to rendered light DOM. Closed shadow roots, iframe contents, hover-only widgets, infinitely scrolling/virtualized content outside the scroll budget, keyboard-only flows and unknown states are not exhaustively explored. Mobile viewports emulate a browser; they are not native-device testing. Use explicit journeys for keyboard, inputs and important business flows.

## Configure UAT

Copy `skills/ai-agentic-usability-testing/assets/matrix.web.example.json` to your project's `.ux/matrix.json`. Replace the URL, journey selectors and expected values with the approved contract. Older education/finance persona examples are optional templates, not universal defaults; their login placeholders must be replaced with positive authentication checks.

Targets use exact roles/names, labels, placeholders, text or explicit selectors. Ambiguous matches fail instead of silently clicking the first result.

Step types:

- `goto`, `reload`, `click`, `fill`, `press`, `select`, `check`, `wait`, `screenshot`.
- `expectText`, `expectNoText`, `expectURL`, `expectVisible`, `expectHidden`, `expectValue`, `expectChecked`, `expectEnabled`, `expectCount`, `expectAttribute`.
- `waitForText`, `measureResponse` (requires observed output and stable completion before the deadline).

For object steps, put the target and expected value together, e.g. `{"expectValue":{"label":"Display name","value":"QA test user"}}`. A count uses `{"expectCount":{"selector":"[role=row]","count":3}}`. Attributes use target + `attribute` + `value`. Positive assertions retry within the step timeout. Negative text checks are point-in-time; place them after a positive loaded-state assertion. A script without at least one successful required explicit acceptance assertion fails rather than claiming UAT acceptance.

Required-step failures and empty/missing journeys fail (exit 1). Comparisons fail with exit 2 for current failures, missing baselines or regressions. Optional-step failures are reported but do not alone fail the journey. All run output directories must be new; existing evidence/baselines are never overwritten. Create a new baseline directory to intentionally rebaseline.

## CLI

From the installed package directory (or this workspace):

```sh
node scripts/affordance_scan.mjs --url http://localhost:3000/dashboard --out .ux/observe-1
node scripts/affordance_scan.mjs --url http://localhost:3000/dashboard --probe-clicks --interact --max-actions 30 --out .ux/explore-1
node scripts/journey_runner.mjs --config .ux/matrix.json --all --journey profile-persistence --interact --allow-writes --out .ux/uat-1
node scripts/journey_runner.mjs --config .ux/matrix.json --all --journey navigation --interact --baseline .ux/baseline-1
node scripts/journey_runner.mjs --config .ux/matrix.json --all --journey navigation --interact --compare .ux/baseline-1 --out .ux/compare-1
node scripts/glitch_lab.mjs nav --url http://localhost:3000/dashboard --interact --out .ux/glitch-1
node scripts/report.mjs .ux --out .ux/report.html --embed
```

Use production-like builds: development hot reload/double rendering creates noise. React 18/19 sensors use DevTools internals and bounded traversal; minified names and unavailable sensors limit attribution. Screencast frames are sampled, not a guarantee of every painted frame. A detected correlation is not proof of root cause. DOM evidence frames may surround rather than capture the transient. A clean run means nothing detected under the reported conditions, not no defects.

## Development

From the repository root: `pnpm install --frozen-lockfile`, then `pnpm test` through your check broker. Browser tests use an ephemeral loopback fixture, not your apps/accounts or AI. Install Chromium explicitly or use the installed Chrome fallback. See the [repository release guide](https://github.com/stacknyu/stack-pi-plugins#release-one-plugin) for independent npm publishing. No GitHub Actions required.
