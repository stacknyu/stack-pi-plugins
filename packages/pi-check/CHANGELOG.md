# pi-check changelog

## 1.2.1

Fixes from an independent review of 1.2.0.

- **Retries can no longer hide failures.** Every failure of the retry run counts, including tests that passed the first time. A retry that gives no verdict (timeout, crash, no result) makes the unit an error, which is never cached and never passes.
- Flaky tests recovered in earlier retry rounds stay reported, also on units that still fail for another reason. `/check flaky` / `pi-check flaky` list all of them (status shows the top 20 plus `flakyTotal`).
- The retry policy is part of a test unit's cache key.
- Batches only combine units of the same lane, so a measured-heavy unit no longer rides in a fast-lane batch.

## 1.2.0

- **Flaky tests.** A failing test is run once more (Go: only the failed tests; other runners: the failed files). If it passes, the unit passes and the test is reported as flaky; `/check flaky` and `pi-check flaky` list them with counts. `flakyRetries: 0` disables.
- **Measured lanes.** Unit durations are recorded; a unit that has run before uses the fast or heavy lane by its real duration (`fastMs`, default 20 s). An explicit `lane` still wins.
- **tsgo.** Projects that depend on `@typescript/native-preview` are type-checked with `tsgo` (with `--checkers` sized to the job's CPU allocation); `tsgo: false` opts out.
- **Quieter ahead-of-time runs.** Speculative jobs run at the lowest CPU priority and idle I/O (`speculateQos: "low"`); `"background"` confines them to efficiency cores on macOS.

## 1.1.1

- Run command helpers asynchronously so native Pi and Pi Web remain responsive; report failed, killed or truncated command results as warnings.
- Skip invisible status polling in print/JSON mode while retaining native/RPC status support and session-local shutdown behavior.
- Add isolated command and lifecycle compatibility regressions.

## 1.1.0

- First standalone public npm package, `@stacknyu/pi-check`, maintained in the Stack Pi Plugins monorepo. pi-flow is not installed as a dependency.
- Includes shared-result revalidation, cancellation fixes, staggered CPU allocation and Go execution/input correctness from the collection's v0.2.0 release.
- Ships its own Pi extension, skill, CLI, release notes and runtime files; supports independent Pi-managed updates.
