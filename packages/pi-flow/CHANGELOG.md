# pi-flow changelog

## 1.11.1

- Existing repositories get a one-time, no-prompt config update when idle. The original is backed up in `.pi-queue/config.json.bak-unversioned`; existing settings, including an explicit empty install command, are kept. New defaults and unknown keys are recorded in the queue log. The schema marker does not change task approval; an already outdated approval is never silently replaced.
- Full-autonomy workers can continue with a named extra file when the task allows it but the item's original file list missed it. Protected files and project checks still apply.

## 1.11.0

From the feedback of two long real runs (1.8.2): pi-flow must refuse its own invalid jobs before a worker is spent on them.

- **Generated fix jobs never exceed the file limit.** A [check]'s findings become one job each. Findings are merged only to fit the round's room, and only while the merged job stays within the task's `maxFilesGrowing`; findings that share a file (a test fixture) stay separate jobs and run one after the other. Before, two four-file findings that shared a fixture became one seven-file job in a five-file task. Findings that do not fit wait for the next round (that round does not count against `gapRounds`), never dropped. A single finding that needs more files starts at what it needs (`[files=n]`). Regression test: the six V90 findings.
- **One admission check for every generated job** (gap fixes, split parts): Done when, areas inside the allowed paths, file count within its limit, focused checks that resolve, known prerequisites, an unused id. A rejected finding is logged (`REJECTED`) with the reason and written to the item's notes; its valid siblings still run, and the check stays open until every finding is resolved. A split is admitted all or nothing.
- **Generated items use their parent's focused checks.** `V90-fix1`, `A01-repair2`, `A01a-fix1` resolve `itemChecks` through the items they came from. Before, they failed before coding with "missing focused itemChecks".
- **`[produces: <path>]`: passing checks are not the result.** An item that declares an output passes only when the file exists, a no-change [check] included. An item whose prerequisite passed but whose declared output is not in the checkout does not start (it needs you). Handoff rejects outputs outside the item's own areas.
- **Items that never started are not failures.** They are reported as "never started (a prerequisite failed)", and they open again by themselves as soon as the prerequisite passes, after a rework or a retry, not only on a manual retry (`REOPENED` in the log).
- **`amend`** (manager tool and `/queue`): give one item exact extra files and/or corrected text without editing `items.md`. Its id, state, dependents and the approval stay; it runs again. `.env`, secrets and CI workflows are never added.
- **Handoff shows the effective settings and where each came from:** setup (or "none"), worktrees, how items run, recovery, and everything kept from the previous run's config.
- **Progress posts** say what landed, what failed, what never started, the root blockers and how many items each holds up, and for each running item whether it is coding or in checks and how long since its last real event.
- Planner: declare `[produces]` for files later items read; keep task `checks` fast, give items focused `itemChecks`, and put full suites on milestone [check] items every 15–25 items; list protected behaviours in the brief (workers are told never to remove them).
- Fix: changing `parallel` while the queue runs now also resizes the background pi pool (1.10).

## 1.10.0

The two things that made unattended runs unusable: a fixer that only retried, and a new pi for every turn.

- **Failed items are reworked, never retried unchanged.** A fresh read-only session reads the code and the failure and rewrites the item: the real file paths, a Done when the code can meet, the files it must also change. Or it makes the item wait for the open item that provides what it lacks, or gives up with the reason (`rework`, `maxReworks: 2`). The next worker gets the rewritten item plus the diagnosis. Rewrites keep the item's id, model/tier and limit tags, and are logged in `decisions.md`. A rework that only repeats the item counts as giving up.
- **Missing files are waited for, not retried.** When an item is BLOCKED on files that do not exist and an open item names them, it waits for exactly that item right away, with no session and no deferral to the end of the queue.
- **Files outside the allowed paths.** Under full autonomy, a change that also touches a few files outside `allowedPaths` is kept and those files are allowed for the item (`widenScope`, at most `widenMax: 12`; never `.env`, secrets, keys, CI workflows, `.git`, `.pi-queue`, `.tasks`). A worker that stopped because it needed such files is told it may change them and continues in the same session. Each widening is logged in `decisions.md`.
- **The supervisor no longer asks a model to retry.** With rework on, a failure gets at most one plain retry if the rework never ran; once rework is exhausted or gave up, the failure reads `needs you: …` and the items waiting on it are released. `rework: false` brings back the model review.
- **No new pi process per turn.** Background items (no Pi Web) run on `parallel` long-lived `pi --mode rpc` processes shared by every item, turn and worktree: a session's tools run in the worktree its session file names, so one process serves any slot. Processes are replaced after `workerRecycle: 20` sessions and closed when the run ends. `workerMode: "json"` restores the old behaviour.
- **Lean workers.** Item workers start without MCP servers (`workerMcp: true` to keep them; every worker used to connect all of them, and some start a browser) and are told not to start subagents (`subagents: true` to allow).
- **`parallel` means agent sessions.** Coding turns and `[check]` sessions together never exceed `parallel` (it used to be up to `parallel` of each, so 2× the agents). Plain check commands still run alongside.
- Tested against the real Pi 1.5.0 CLI (`realpi.test.mjs`): RPC protocol, session switching across worktrees, tool writes landing in the right worktree, rework, process count and cleanup.

## 1.9.0

Fixes for what broke unattended runs in practice.

- **Your parallelism is the ceiling.** Handoff no longer lets the plan's `parallel` replace yours (a planner's 2 overrode a configured 20). The planner is told to leave it out unless you gave a number.
- **Read-only items** (`[readonly]`): audits and investigations lock no areas, so any number run at once; they pass without changes, their findings are saved to `.pi-queue/reports/<id>.md` and given to every item with `[after]` on them. Changing a file fails them.
- **One stuck item no longer ends the night.** When a failed item is out of automatic retries, the supervisor releases it: items waiting on it run anyway and are told it failed. Not for environment, credential or scope failures, and not with `autonomy: "ask"` (`releaseDependents: false` to opt out). WAITING on an item that already failed is BLOCKED at once instead of re-running.
- **Retries run stronger.** A retried item (not a timeout or provider error) uses the plan's heavy tier if it has one, high reasoning effort and 1.5× the time.
- **Repair budget grows with the queue:** at least 5% of the items (up to 10%), and at least 3 restarts.
- **No more runaway RAM.** Workers are told to stop every server, emulator and watcher they start. After each item, processes still running inside its worktree are stopped, and iOS simulators booted during the run are shut down once nothing else runs (`killStrays: false` to opt out). No new item starts while less than `minFreeMemoryGB` is available (default max(4 GB, 12% of RAM)).
- **The planning chat is the control room.** After handoff it acts as the manager (rules plus a fresh queue overview on every turn), and it posts a progress report every `progressMinutes` (20) without waking the model: counts, pace, ETA, what needs you, recent automatic actions; immediately when the queue stops or something needs you.

## 1.8.2

Fixes from an independent review of 1.8.0/1.8.1.

- **Recovery never resets unsaved work.** Interrupted or leftover work is committed (or stash-snapshotted), the `queue-failed/…` branch is created and checked to point at it, and only then is the worktree reset. Any failed step leaves the worktree untouched and the slot reserved.
- **An unreachable Pi Web is not proof a worker stopped.** A Web worker counts as stopped only when its own server refuses connections (the worker's Pi Web URL is now recorded). A timeout, a wrong port or no recorded URL keeps the slot reserved.
- **A split is never cut short.** If the agent's decomposition has more parts than `splitMax` / the growth budget allow, the item fails as "needs you" instead of keeping the first parts (which would complete the parent without the rest). The split prompt states the real maximum.
- **Growth budget holds under parallel workers.** Split and gap-fix capacity is reserved per item before the agent turn and released once the items are recorded (or on a crash).
- **Handoff keeps `manager: false` and a custom `setup`.** A setup you wrote wins over the detected install.
- **Tiers that only set thinking** are validated against the task's model, not the planning chat's.
- `report.md` and `decisions.md` are archived with the previous run.
- `retry`, `limits` and `skip` (and `answer`) start a stopped queue; `next`, `unpark`, `recheck`, `rerun` no longer do, and nothing starts over a PAUSE/STOP (this was also the double-start race in `supervisor.test.mjs`).

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
