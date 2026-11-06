# pi-check

One check runner per repo, shared by every Pi session and every worktree. It handles tests, type checks and linters for **Go, TypeScript/JavaScript and Python**:

- **Only what changed.** A check is split into small units: a Go package, a test file, a project's typecheck, a file's lint. Each unit knows which files it depends on, through the import graph. An agent's check runs only the units its changes touch.
- **Same files, one run.** Each unit is keyed by the content of everything it depends on. If five worktrees ask for the same unit with the same files, it runs once and all five get the result. A unit already running is joined, not repeated.
- **Ahead of time.** The broker watches every checkout. When files change, the affected units run at low priority, so results are often ready before the agent asks. These runs never take the last free slot, and they stop when the machine is busy, when an agent's request needs the slot, or when their files change again.
- **Pre-existing failures are separated.** Failures that also fail on the base branch are reported as pre-existing and don't fail the check. Agents fix what they broke, not old debt.
- **Short checks have reserved capacity.** One broker/cache, with fast and heavy scheduling lanes—not independent unlimited queues per language. Fast checks cannot be trapped behind long Go suites, and heavy work retains its own slots. With three job slots, two heavy jobs and one fast job can coexist.
- **Useful throughput, not a utilization ceiling.** Agent count is independent of check concurrency. A shared CPU budget is divided among runnable jobs; Go runs one package per job, rather than multiplying package and runtime parallelism. For tests sharing ports/databases, set the project's `parallel: 1`.

## Install

```bash
pi install npm:@stacknyu/pi-check   # then reload Pi / Pi Web
```

This installs only pi-check; pi-flow is not required. Update only this plugin with `pi update npm:@stacknyu/pi-check`, or remove it with `pi remove npm:@stacknyu/pi-check`. See the [repository README](https://github.com/stacknyu/stack-pi-plugins#readme) for publication status, migration, local development and release procedures. The first check starts the broker. It runs in the background and stops after 3 idle hours.

## Use

**Agents** use the `check` tool. They also get a prompt rule that asks them to use it instead of running `go test`, `pytest` or `vitest` in bash. If they run those anyway:
- `go test` / `go vet`, including inside `make`, go through a `go` shim to the broker, per package, with Go's normal output.
- Other test, typecheck and lint commands (`pnpm test`, `npx tsc --noEmit`, `pytest`, `ruff`…) run through the broker as a whole command. That run is shared and cached for identical files, and throttled.
- Commands that change files (`--fix`, `-u`, `install`, `--watch`) always run normally.

**You:**

| | |
|---|---|
| `/check` | status: what runs, what waits, time saved |
| `/check run [all]` | run what your changes affect, or everything |
| `/check baseline` | run everything on the main checkout (records pre-existing failures) |
| `/check known [clear\|remove <text>]` | the pre-existing failure list |
| `/check speculate [all]` | queue affected (or all) units ahead of time |
| `/check cancel` | drop queued ahead-of-time work for this checkout |
| `/check init` | write `pi-check.json` with what was detected |
| `/check reload` | apply configuration once requested work drains; never restart active checks |
| `/check projects` / `log` / `stop` / `restart` | |

The same commands are on the command line: `node /path/to/pi-check/cli.mjs run`, `status`, `exec -- <cmd>`, and so on (`--json` for scripts).

## What it detects

| Language | Units | Tools |
|---|---|---|
| Go | per package: `vet`, `test` | `go vet`, `go test -json`. Inputs: package files, `testdata/`, `//go:embed` files, every in-repo package it and its tests import, `go.mod`/`go.sum` |
| TypeScript / JS | `typecheck` per package, `lint` per file, `test` per test file | `tsc`/`vue-tsc` (incremental), `eslint`/`oxlint`, `vitest`/`jest`. Inputs: static import graph incl. tsconfig `paths` and workspace packages, configs, setup files, lockfile |
| Python | `test` per test file, `lint` per file, `typecheck` per project | `pytest` (project `.venv` first, then `uv`/`poetry`, then PATH), `ruff`, `mypy`/`pyright` when configured. Inputs: import closure, `conftest.py` chain, configs |
| Custom | one unit | any command, with the input globs you give it |

Projects are found by `go.mod`, `package.json` (+ `tsconfig.json` / vitest / jest / eslint / oxlint), and `pyproject.toml` / `setup.cfg` / `pytest.ini`.

## Settings: `pi-check.json` at the repo root (commit it; `.pi-check/config.json` overrides locally)

```json
{
  "maxJobs": 0,
  "speculate": true,
  "intercept": "route",
  "ignore": ["**/generated/**"],
  "projects": {
    "apps/pocketbase": {
      "test": { "timeout": "30m", "env": { "PB_SQL_LOG": "0" }, "inputs": ["migrations/**", "pb_schema.json"] },
      "vet": false
    },
    "apps/dashboard": { "lint": { "exclude": ["src/legacy/**"] } }
  },
  "custom": [{ "name": "openapi", "cwd": "docs", "cmd": "node scripts/check-openapi.mjs", "inputs": ["docs/api/**"] }]
}
```

| Setting | Default | |
|---|---|---|
| `maxJobs` | 0 = CPU budget | maximum jobs across all checkouts |
| `cpuBudget` | 0 = available cores | total cooperative CPU allocation; independent of agent count |
| `threads` | 0 = automatic | per-job ceiling when positive; automatic allocation divides spare capacity at dispatch |
| `fastLane` | true | reserve one job slot and one CPU allocation for short checks; disabled automatically with only one slot/core |
| `nice` | 10 | process priority of check runs |
| `speculate`, `warmBase` | true, false | affected-only ahead-of-time work; full baseline warming is opt-in |
| `speculateMaxLoad` | 0.75 | ahead-of-time work only while load < cores × this |
| `intercept` | `"route"` | raw check commands in agent bash: `route` through the broker, `block` (use the tool), `off` |
| `shimGo` | true | `go test`/`go vet` in agent bash go through the shim |
| `base` | the branch the main checkout is on | what "changed" and "pre-existing" compare against |
| `strict` | false | count pre-existing failures as failures |
| `projects.<dir>.<kind>` | | `false` disables. `{ args, env, timeout, parallel, inputs, exclude, cmd, lane }`. `inputs` are extra globs (project-relative) the tests read at run time. |
| `groups` | | concurrency per group, e.g. `{ "go:apps/pocketbase:test": 2 }` |
| `custom` | [] | extra checks: `{ name, cwd, cmd, inputs, timeout, env, lane }` |
| `ignore` | [] | globs that are never inputs (generated files, data dirs written by tests) |

## Fast and heavy lanes

`maxJobs` remains the total limit. With `fastLane: true`, one slot/CPU stays reserved even when no fast check is waiting; a long job cannot borrow it and block a later short request. The remaining slots/CPU serve heavy checks. Use `maxJobs: 3` for two heavy jobs plus one short job; with two slots the split is one plus one. `fastLane: false` retains the original shared scheduler. No running requested job is preempted or resized. Automatic per-job allocation leaves capacity for a second heavy requester even when the first arrives alone, rather than leasing the whole heavy budget.

Native lint, vet, typecheck and TypeScript tests default to fast. Fast test batches are bounded to eight units. Recognizable raw type/lint and Node test commands also use that lane; Go tests, builds and unknown commands default to heavy. These are hints, not promises about duration: move slow integration suites or large typechecks to `projects.<dir>.<kind>.lane: "heavy"`, or set `lane` on a custom check. Use `"fast"` for verified short checks. Group limits, priorities/FIFO within each lane, content-cache keys and cross-worktree joins are preserved. The fast lane has at most one running job, so it cannot consume every heavy slot. Status JSON exposes the scheduler revision and per-lane running/queued counts; progress names each running job's lane. Tool allocations are cooperative, not an OS CPU/memory cap.

Source updates require a fresh broker process; `/check reload` reloads configuration, not JavaScript. Keep active checks on their current process and wait for a natural idle exit before starting the updated broker. Do not restart a busy broker to activate scheduling changes.

## With pi-flow

pi-flow uses pi-check automatically when both are installed. Queue checks go through the broker, and item agents are told about the `check` tool. `"checks": ["pi-check"]` in a task runs exactly what each item affects, with pre-existing failures ignored. See pi-flow's README.

## Good to know

- Configuration changes use `/check reload`, not restart. Active and already queued requested work keeps its original configuration. Allocation changes never kill/restart a running job. These are cooperative tool limits, not an OS CPU cap; arbitrary commands can override them.
- Whole-command/custom jobs already own a broker allocation. Nested pi-check/Go shims run inside that allocation instead of acquiring a second slot. Prefer the native `check` tool for per-unit sharing; arbitrary shell commands are cached as whole commands, not decomposed.
- Broker connection errors do not automatically launch duplicate direct checks. Inspect status before retrying. An upgrade refuses to replace a busy broker.
- Status includes elapsed time, allocation and the latest Go test event. Reused unit-runtime is not wall-clock savings. Quiet tests may produce no events until completion.
- Producers refresh input structure before caching; requesters revalidate their own checkout after execution and baseline classification. Changed inputs produce a stale failure, not an implicit rerun on different content. Cancelling a tool detaches its request without cancelling other waiters.
- Go ignores unrelated automatic JavaScript/Python lockfile inputs, but preserves explicit runtime inputs. Native sources, transitive embeds, effective toolchain/environment and timeouts participate in keys. Conditional packages use Go's build eligibility. Identical in-repo Go workspaces can share across worktrees; runtime fixtures outside the dependency graph still need explicit inputs.
- Benchmarks, profiling and artifact-producing Go fallback commands execute rather than reuse whole-command results. CPU allocations override forwarded `GOMAXPROCS`; arbitrary shell commands can still override cooperative limits themselves. Changed key semantics cause a one-time cold cache.
- Plugin discovery and shims honor `PI_CODING_AGENT_DIR`, including isolated profiles.

- **Pre-existing** means: the same unit fails on the base branch tip in the main checkout, or in any worktree with identical inputs. `/check baseline` records them all at once. The broker also does this by itself when it starts (`warmBase`).
- **Tests that read files at run time** outside their package (`../../fixtures`) need those files in `inputs`. Otherwise a change there won't rerun them. Embedded files and `testdata/` are already covered.
- **Tests that write into the repo** (a data dir that isn't git-ignored) change their own inputs. pi-check notices and stops running them ahead of time. Git-ignore that dir, or add it to `ignore`.
- **Timeouts are never cached.** A Go test that hits its timeout is reported, with a hint to raise `timeout`, and runs again next time.
- State lives in `.pi-check/` in the main checkout (kept out of git automatically): `cache/`, `known.json`, `state.json`, `broker.log`.
- The collection requires Node 22.19+, Pi, git, and the tools your projects already use. macOS and Linux; tested with Pi 1.5.0.
