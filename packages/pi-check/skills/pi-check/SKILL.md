---
name: pi-check
description: How the shared check broker (pi-check) works — the check tool, reading its report, pre-existing failures, configuring pi-check.json, and fixing slow or wrong checks. Use when running tests/typecheck/lint, when a check result is confusing, or when the user asks about pi-check, /check, check speed or CPU load.
---

# pi-check

One broker per repo runs every test, type check and lint for all sessions and worktrees. Results are keyed by file content, so identical work runs once and is shared.

## Running checks

- Use the `check` tool, not `go test` / `pytest` / `vitest` / `tsc` / `eslint` / `ruff` in bash.
  - Default scope: what your changes affect, compared with the base branch.
  - `scope: "all"`: everything.
  - `files: [...]`: only checks that depend on those files.
  - `kinds: ["test"]` / `projects: ["apps/x"]` narrow it further.
- Run it after a meaningful batch of edits. The broker already runs affected checks in the background while you edit, so results are often instant.
- Raw commands in bash still work: they are routed through the broker. Commands that change files (`--fix`, `-u`, `install`) run normally.

## Reading the report

```
pi-check · w2 · scope: changed vs main · 41 units: 8 ran, 28 cached, 5 shared · 3m12s
✗ go apps/api · test: 36/37 pass — 2 pre-existing failures (also fail on base)
   ✗ example.com/api/billing TestInvoiceTotals
     invoice_test.go:42: got 10, want 12
RESULT: FAIL — 1 new failure
```

- **cached / shared**: the result came from an identical earlier run, here or in another checkout. It is as valid as a fresh run.
- **new failure**: not failing on the base branch. Yours to fix.
- **pre-existing**: also fails on the base branch. Don't fix it unless that is your task. It doesn't fail the check.
- **"files changed during the run"**: the result may not match the current files. Run `check` again.
- **could not run** (tool missing, timeout): an environment problem, not a code verdict. Mention it, don't loop on it.

## For the user

- `/check`: what runs, what waits, time saved.
- `/check baseline`: records pre-existing failures from the main checkout.
- `/check known`: lists them.
- `/check run all`: runs everything.
- `/check init`: writes `pi-check.json` to commit and tune.
- In `pi-check.json`:
  - `projects.<dir>.<kind>`: `false` to disable, or `{ timeout, env, args, inputs, exclude, parallel }`.
  - `maxJobs`: maximum concurrent jobs (0 = CPU budget).
  - `cpuBudget`: total cooperative allocation (0 = available cores), independent of agent count.
  - `threads`: per-job ceiling (0 = divide spare allocation at dispatch).
  - `fastLane`: reserves one total job slot/CPU for short work when capacity permits. Three slots allow two heavy jobs plus one fast job; two slots allow one of each. It never preempts running requested work.
  - `projects.<dir>.<kind>.lane` / `custom[].lane`: `fast` or `heavy`; put slow integration suites/large typechecks in heavy. Native lint/vet/typechecks/TS tests and recognizable raw type/lint/Node-test commands default fast; builds/Go tests/unknown commands default heavy.
  - `warmBase`: full-suite cache warming, off by default; normal speculation is affected-only.
  - `speculate`: ahead-of-time runs.
  - `intercept`: `route` | `block` | `off`.
  - `ignore`: globs that are never inputs.
  - `custom`: extra checks.
- After editing `pi-check.json`: `/check reload`. It waits for requested work to finish; active checks are not restarted. Source-code updates need a fresh broker process after a natural idle exit; config reload alone cannot hot-swap JavaScript.
- Broker errors are not permission to launch competing direct checks. Inspect status first. An upgrade must wait for active checks to finish.
- Whole-command jobs hold their own allocation; nested shims execute inside it. Prefer native units for fine-grained cache sharing.
- Progress includes the latest Go test event and elapsed time. Reused unit-runtime is not elapsed time saved.

## When something is off

- **A change didn't rerun a test that reads a file at run time:** add that file's glob to the project's `inputs`.
- **A unit keeps rerunning by itself:** its tests write files into the repo. Git-ignore them, or add them to `ignore`.
- **Go tests time out:** set `projects.<module dir>.test.timeout` (e.g. `"30m"`). Timeouts are never cached.
- **The machine is still busy:** lower `maxJobs`, set `speculate: false`, or raise `nice`.
- **Wrong "pre-existing" list:**
  - `/check known clear`, then `/check baseline`.
  - "Pre-existing" means failing on the base branch tip, in the main checkout (or an identical worktree).
- **The broker misbehaves:** `/check log`, then `/check restart`. The cache is in `.pi-check/cache/`. `pi-check forget` clears it.
