# pi-flow changelog

## 1.8.1

Fixes the "false DONE" failure: an item that kept the old implementation because of a size cap passed and was reported as done.

- **A size stop is never answered with "make it fit".** Once no larger size level is left, a `NEEDS` / over-limit result fails the item (or splits it). Before, the fix round told the worker to stay under the limit, so it dropped the real change and replied DONE.
- **Lockfiles don't count toward size limits** (pnpm/npm/yarn/bun, go.sum, Cargo, Poetry, uv, Gemfile, composer, Podfile, flake, `__snapshots__/`; more via `generatedPaths`). They must still be in scope.
- **DONE must mean Done when.** The worker prompt forbids passing off a partial change, a kept old implementation, or an explanation as DONE. A DONE reply that admits a shortfall ("kept", "retained", "exceeds the cap", "instead of", "not migrated"…) gets one confirmation turn: finish it, reply NEEDS/BLOCKED, or `DONE: CONFIRMED` with evidence per condition.
- **Plan lint:** a "Done when" with an escape hatch ("if incompatible/slower, keep the original and report why") is rejected at handoff.
- **Handoff resets the queue's strictness.** Only operational settings (parallel, Pi Web, setup, …) carry over from an old or hand-written `.pi-queue/config.json`; limits, escalation, splitting and fix rounds come from the defaults and `task.json`. The planner is told not to write that file.
- **`[check]` items always run.** A check whose covered item failed still runs, is told which items failed, and judges passed items by the code rather than their DONE messages.
- After a run that changed dependencies, the setup command runs once in the main checkout, so its own checks don't fail on a stale install.

## 1.8.0

Audit pass for fully unattended runs.

- **Provider outages no longer kill the queue.** A session/provider error before the agent did any work (rate limit, overload, expired login, network) is waited out in the same session with growing pauses (30 s → 30 min, up to `outageMinutes`, default 180). All workers hold while one sees an outage. Before, each item failed in seconds and used up its retries.
- **Autonomous decisions** (`autonomy: "full"`, the default; `"ask"` in `task.json` to opt out). The automatic manager answers `BLOCKED: decision:` questions from the brief, rules and answers, records each in `.pi-queue/decisions.md` and the end report, and reruns the item. Environment, credentials and scope blockers still wait for you.
- **Slots recover inside a run.** A runner error stops the worker, keeps its work on a branch, frees the slot at once and tries the item again (twice at most). Before, each error quarantined a slot until the next restart.
- **Faster merges.** Rebase and re-check happen outside the merge lock; under the lock only a fast-forward remains unless the branch moved again. One item's checks no longer hold up everyone's merge.
- **Timeouts keep their work.** An item that runs out of time gets one shorter turn in the same session to finish; if it still fails, its next attempt gets 1.5× the time.
- **Start failures retry.** A failed setup/install, failing baseline or missing Pi Web is retried after 1 and 5 minutes.
- **Manager chat.** Manager mode is attached to the chat (session name `manager…`): its rules and a fresh queue overview are added to every turn, so it survives reloads and compaction. The automatic manager's own session is now named `auto manager · <task>`.
- Pi Web unreachable for 5 minutes ends that worker's turn (was: the whole item time). A merge conflict left after the in-session redo is retried without a model.

## 1.7.0

Unattended runs: fewer stops, no queue blow-up, plans that fit the queue.

- **Bounded growth.** `BLOCKED` items are never split (it multiplied the blocker). Only an item still too big after the last size level is split, into 2–4 parts (`splitMax`). A `[check]` round adds at most 3 merged fix items (`maxGapItems`). All derived items share one budget: `growthMax`, default max(8, 30% of the planned items). Past it, items fail as "needs you" instead of adding more.
- **Blockers.** Workers reply `WAITING: <ids>` when another item's work is missing: the item is queued again after those items, with no failure. `ALREADY DONE:` passes on the checks instead of failing "no changes". `BLOCKED: decision:` / `BLOCKED: env:` go straight to you; other `BLOCKED` reasons may be retried by the automatic manager with a diagnosis.
- **No more stuck restarts.** Interrupted workers (crash, sleep, Pi Web restart, runner error) are reconciled at the next start: still-running workers are stopped, their changes are kept on `queue-failed/<id>-interrupted-*`, the worktree is freed and the item queued again. `autoReconcile: false` restores the old fail-closed behaviour.
- **Supervisor.** A dead runner is restarted without a model turn; the restart budget counts restarts without progress. Timeouts and session/provider errors are retried without a model (`retryTransient`). If the manager model cannot be reached, the item is retried with its recorded evidence. The manager runs as background pi (`managerIn: "web"` to opt back), with optional `managerModel` / `managerThinking`. Changing `parallel` no longer revokes automatic management. macOS: `caffeinate` keeps the machine awake while supervised (`keepAwake`).
- **Pi Web loss.** A failed session creation is an ordinary retryable failure, not a quarantined slot; when Pi Web is gone, new items run as background pi.
- **Planning.** `task.json` gains `limits` (task-wide size/time limits) and `tiers` (named model/effort presets for `[tier: light|standard|heavy]`). The planner gets explicit granularity rules. Handoff lints the plan: items to merge, items that name another item without `[after]`, and plans whose areas serialize the queue; `"planLint": "accept: <reason>"` overrides.
- **Manager.** `queue_overview` groups failures by what they need and how many items each holds up. New actions: `answer` (your decision for blocked items, then retry), `limits`, `skip`. Retry-type actions start the queue when it is not running. `/queue report`, `/queue answer <id> <text>`, `/queue skip <ids>`; a report is written to `.pi-queue/report.md` at the end of each run.
- Defaults: `fixRounds` 2 (was 1), `splitMax` 4 (was 8); the baseline check is tried twice before the run is refused.

## 1.6.0

- Separate bounded coding and verification capacity in worktree mode so independent implementation continues during checks; retain verified dependency gates and worktree/area ownership. Direct-repo mode stays serial.
- Run disjoint parked work concurrently, stop shrinking global width after a local conflict, and disable the global consecutive-failure halt by default (explicit positive limits remain supported).
- Wake the automatic manager on live failure/lifecycle events, retain incidents during reviews, and use a 60-second watchdog fallback without healthy model calls. Recovery keeps persistent budgets and respects manual stop/pause and uncertain worker ownership.
- Add upfront, task-specific recovery authority for targeted repair items. Repairs inherit the failed item's checks, model and limits and are restricted to its areas; legacy plans retain retry/restart-only authority.
- Add actual-runner overlap, phase-bound, conflict, blocker, quarantine and supervised-recovery regressions. No per-item reviewer or new runtime dependency.

## 1.5.2

- Add optional fresh-context plan-review guidance: one read-only reviewer paraphrases consequential plans and reports up to three evidence-backed gaps before handoff.
- Honor review opt-outs and explicit review requirements; report unavailable or failed delegation honestly and keep dispositions in the existing plan without automatic repeat rounds.
- Document native Pi/Pi Web host limits and add prompt-contract regressions. Queue execution, worker backend settings and enforced handoff gates remain unchanged.

## 1.5.1

- Support Pi Web 0.15.0 session-history results, including compaction, fresh-answer validation and nested subagent completion/abort checks; preserve native CLI workers.
- Isolate live queue widgets per session, honor Web cleanup refusals, retain retryable cleanup, and batch delete/archive requests within Web's 500-session limit.
- Explain cancelled or unsupported session navigation and add native/RPC/Web compatibility regressions.

## 1.5.0

- First standalone public npm package, `@stacknyu/pi-flow`, maintained in the Stack Pi Plugins monorepo. pi-check remains optional and is not installed as a dependency.
- Includes approved-scope automatic supervision, durable queue controls, worker ownership protection, dependency-aware scheduling and optional pi-check worktree integration from the collection's v0.2.0 release.
- Ships its own Pi extension, skill, release notes and runtime files; supports independent Pi-managed updates.
