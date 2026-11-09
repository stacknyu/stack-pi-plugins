# pi-flow

Hand Pi a big task (hours of work), answer its questions once, and let a queue of fresh sessions build it, checked and committed one item at a time. It works in any git repo, in the plain Pi terminal app or in Pi Web. Pi Web is optional: it only adds a richer live view.

```
/task setup              once per repo: plugins from your profile, verified checks, AGENTS.md block
/task <what you want>    plan it in this chat → it asks its questions → it starts the queue itself
/task manage             make this chat the queue's manager: ask what is wrong, tell it to retry/recheck/rerun
/task status             your tasks and the queue
/task cleanup [--all]    delete the task's finished Pi sessions (--all: also worktrees and failed branches)
/task resume <slug>      continue planning a task in this chat (e.g. after closing the old one)
/task save-profile       remember this repo's project plugins for /task setup elsewhere
/queue log <id>          what an item is doing / did (live activity + result)
/queue open <id>         terminal: open a finished item's session here (Pi Web: it is in the sidebar)
/queue retry [id] | recheck [id] | rerun <id> | unpark | parallel <n>   steer it (works while it runs)
/queue status | pause | stop | start | watch | problem                         control the queue by hand
```

Full documentation ships with the package as the **pi-flow skill** (`skills/pi-flow/`): `guide.md`, `items.md`, `manager.md`, `troubleshooting.md`. The planner and the manager read it, and you can ask any chat "how does pi-flow …" or run `/skill:pi-flow`.

## Install

```sh
pi install npm:@stacknyu/pi-flow
```

Reload Pi. This installs only pi-flow. pi-check is optional: install it separately with `pi install npm:@stacknyu/pi-check` if wanted. Update only this plugin with `pi update npm:@stacknyu/pi-flow`, or remove it with `pi remove npm:@stacknyu/pi-flow`. See the [repository README](https://github.com/stacknyu/stack-pi-plugins#readme) for publication status, migration, local development and release procedures.

## The workflow

**1. Set up the repo, once.** Run `/task setup`. It takes a few minutes and does four things:
- installs the plugins from your profile (`/task save-profile` in a repo you like creates it)
- detects the stack (pnpm/npm/yarn/bun workspaces, Go, Rust)
- **runs every typecheck, lint and build command once**: only the ones that pass today can become a task's checks, and the ones that fail are listed with their output in `.pi-flow/setup-report.md`
- adds a short managed block to `AGENTS.md` and removes stale harness blocks (the old GLLA one). It commits only `AGENTS.md` and `.pi/settings.json`, and only if you had no edits there.

**2. Start a task.** Type `/task migrate the dashboard to the new permission API` (or anything big). This chat becomes the planning session. It:
- researches the code, using subagents for parallel read-only searches
- writes `.tasks/<slug>/`:

| File | What |
|---|---|
| `brief.md` | goal, what "done" means, out of scope, risks |
| `inventory.md` | facts found in the code, with paths: the evidence |
| `map/<area>.md` | per area: what changes, what must not |
| `rules.md` | task-specific rules for every item |
| `questions.md` | decisions only you can make |
| `items.md` | the work list |
| `task.json` | allowed paths, checks, suggested parallelism |

**3. Answer its questions.** It asks them all here in one message, each with a recommended answer. Reply in plain words. It records the answers and updates the plan.

Before handoff, the planner can use one fresh read-only reviewer for consequential plans or when you request a plan review. Routine changes skip it, and "skip plan review" opts out. Findings stay in the existing plan; missing reviewer support is reported honestly. This is guidance, not a new enforced gate; see [plan review and host limits](skills/pi-flow/references/guide.md#optional-fresh-context-plan-review).

**4. It hands off by itself.** The planning agent calls `task_handoff`, which refuses until the plan is sound:
- every question is answered
- every item has an id, a "Done when" and `[areas: …]`
- `[after: …]` names real ids and the dependency graph has no cycles
- the checks pass on today's code
- the tree is clean

Then it commits `.tasks/<slug>/` and starts the queue. The live panel appears under the chat.

**5. Watch or walk away.** The live panel under the chat shows each running item and what it is doing. Passing items become one commit each: `A01: <title>`.
- **Pi Web:** each item is a real Pi Web session named `queue A01: …` that you can open to watch thinking and edits live. The planning chat is pinned at the top while the queue runs, as the task's control room.
- **Terminal (no Pi Web):** items run as background `pi` processes. `/queue log A01` shows what an item is doing. `/queue open A01` opens a finished item's session right in your terminal. The files are in `.pi-queue/sessions/` (`pi --session <file>` works too).

**6. Clean up.** When the run ends, the finished item sessions are deleted automatically, from Pi Web or from `.pi-queue/sessions/` (`deleteSessions`; `"archive"` archives them in Pi Web instead). Sessions of failed items are kept so you can read them.
- `/task cleanup` removes those and the planning chat (unless you are in it), and unpins it.
- `--all` also removes worktrees and `queue-failed/*` branches. It keeps the worktrees while any item session still exists, because Pi Web would otherwise show those sessions as a stray project.

## The manager

An approved queue automatically gets a dedicated manager after its baseline passes. A detached supervisor checks health every 60 seconds without model calls; on a terminal failure the chat-only manager can propose bounded retries of existing items. Scope, checks, manual pause/stop and worker ownership remain enforced by code. It does not invent new work or reset uncertain worktrees. See [manager policy and limits](skills/pi-flow/references/manager.md).

`/task manage` still makes any chat a separate **manual** manager (pinned in Pi Web), acting only on what you ask. Ask it things like:
- "what is wrong?": it reads the failures together and tells you the real cause (e.g. "these 6 checks failed because P03 had not run yet")
- "what happened with P28d?": the item's status, commit, last reply and activity
- "re-run the checks for member detail", "retry P28", "let the parked items run", "run 3 at once", "stop", "start"
- "add an item to fix X": it proposes the work-list line and adds it once you agree

It steers a running queue through an inbox the runner reads between items, so nothing collides; every action shows as a `CONTROL` line in the log. It cannot edit code, revert commits or delete branches. Queue items themselves cannot use these tools.

## Items

```
- [ ] A01 — Add the permission adapter in lib/auth/perm.ts. Done when: … [areas: apps/web/lib/auth]
- [ ] A02 — Use it on the Members page. Done when: … [areas: apps/web/app/members] [after: A01]
- [ ] B01 — Backend: add the count endpoint. Done when: … [areas: apps/api/handlers/count.go] [big]
```

- `[areas: …]`: the folders and files the item changes. Items with overlapping areas never run at the same time; disjoint ones run in parallel.
- `[after: …]`: the item waits until those items pass. If one of them fails, the item is failed without running. `[after: *]` waits for everything else.
- `[big]` or `[files=15 lines=500 min=60]`: start the item at higher limits.
- `[model: provider/id]` and `[thinking: level]`: selected during planning from the authenticated catalog, validated at handoff, and honored by CLI/Web workers. See `skills/pi-flow/references/items.md` for defaults and inheritance.
- `[check]`: a verification item. It passes **without changes** when everything holds; it may fix tests/docs; when it finds production code that is wrong it reports `GAP:` lines, the queue adds fix items (`V01-fix1`, …) before it and checks again (up to `gapRounds`). Give it `[after: …]` the items it verifies.

## What the queue does for you

- **The runner judges, not the agent.** Every item is checked for:
  - files only under the task's `allowedPaths`
  - its size limits
  - all checks passing

  If a check fails, the agent gets one round to fix it. Otherwise the work is set aside on `queue-failed/<id>`.
- **Sizing:**
  - An agent that sees the item is too big replies `NEEDS: 20 files, 900 lines`, and the runner jumps straight to a limit level that fits.
  - An agent that stops on size gets the next level.
  - If an item still can't be finished, the same agent splits it into 3–8 smaller items (`A01a`, `A01b`, …, with their own areas and order), which run next.
  - Typing "bypass limits" in an item's session lifts the size limits for that item.
- **Smart re-queuing:**
  - An item that says `BLOCKED` while other work is still pending (usually a prerequisite that has not run yet) is **deferred** and tried again after that work (`DEFERRED` in the log). Only a second BLOCKED, with nothing left that could help, makes it fail. A real decision or missing environment still ends up as a failure for you.
  - A passed `[check]` runs again automatically (`RECHECK`) when an item it covers (overlapping areas, or named in its `[after: …]`) changes later.
- **Dependency scheduling:** reject cycles and duplicate dependency/area tags. Prefer ready prerequisites on the longest remaining chain, preserve explicit `next` order, and fill slots with disjoint ready work. File order only breaks ties; do not serialize independent items with unnecessary `[after]` tags.
- **Adaptive parallelism:** the queue runs up to `parallel` items at once. A conflict narrows it by one, and 3 clean passes in a row widen it by one, between `parallelMin` and `parallel`. A conflicting item is first redone in the same session on the latest code. Only if that fails too is it retried at the end.
- **Safety:**
  - checks run once on the unchanged code before anything starts
  - the run stops after 5 real failures in a row
  - `BLOCKED: <reason>` (a missing decision or contract) is never forced: those items wait for you
- **Clean environment:** setup and checks run without the npm/pnpm variables leaked from Pi Web's own process.

## With pi-check (optional, separate plugin)

When [pi-check](https://github.com/stacknyu/stack-pi-plugins/tree/main/packages/pi-check) is installed, the queue uses it automatically (nothing to configure):

- Every check command goes through pi-check's shared broker. `go test` / `go vet` run per package and are cached by file content. Other commands run once per identical set of files, and every worktree shares the results. Heavy runs are throttled, so parallel items stop fighting for the CPU.
- Go test failures that also fail on the base branch are "pre-existing": they no longer block items or the baseline.
- Before starting a worktree worker, pi-flow exposes the discovered pi-check installation through an ignored directory symlink at `.pi/extensions/pi-flow-check`. Project-local installations therefore provide the `check` tool and `/check` immediately, without reinstalling packages or copying settings/secrets. Pi deduplicates the same physical extension when it is also installed globally. This does not copy other plugins or skills.
- Item agents are told to use the `check` tool. It runs only what their change affects, and they see which failures are theirs.
- `"checks": ["pi-check"]` is the native form. One entry runs the tests, type checks and lint the item affects in every Go/TypeScript/Python project, and ignores pre-existing failures in all of them. The planner suggests it when pi-check is installed.
- `"checkBroker": false` in `.pi-queue/config.json` disables this integration and removes the managed link when preparing a reused worktree. Independently installed global plugins remain enabled; existing sessions need restarting to change their loaded tools.

## Settings (`.pi-queue/config.json`, written by the handoff)

Your own edits are kept across tasks. Useful ones:

| Setting | Default | |
|---|---|---|
| `parallel` / `parallelMin` | from the plan / 1 | width range |
| `adaptive` | true | change the width on conflicts and clean streaks |
| `model`, `thinking` | Pi default, high | default model for item sessions and the isolated manager |
| `manager` | true | automatic bounded supervision after approved handoff; false disables it |
| `itemMinutes` | 40 | time limit per item (raised levels give more) |
| `maxNetLines`, `maxFilesGrowing` | 150, 5 | starting size limits |
| `escalate` | 15/600 → 40/1500 → 200/5000 | size levels |
| `autoSplit`, `redoOnConflict` | true | |
| `deferBlocked`, `autoFix`, `recheck` | true | smart re-queuing, gap fixing, automatic re-checks |
| `gapRounds` | 2 | fix rounds a [check] may trigger |
| `deleteSessions` | `"end"` | `"pass"` deletes right after each pass, `"archive"` archives in Pi Web, `false` keeps them |
| `runIn` | `"auto"` | items as Pi Web sessions when Pi Web runs, else background `pi`; `"web"`/`"cli"` force one |
| `copyFromRepo` | [] | git-ignored files (`.env.local`) copied into each worktree |
| `checkBroker` | auto | `false`: run checks directly even when pi-check is installed |

## Files

| Where | Committed | What |
|---|---|---|
| `.tasks/<slug>/` | yes | the plan, which is what every item reads |
| `.pi-flow/` | no | `repo.json` (verified checks), `setup-report.md`, `status.json` |
| `.pi-queue/` | no | config, log, state, notes per item, worktrees, archive of earlier runs |

## Rules while it runs

- Don't commit to the task's branch or edit files in the repo folder: the queue fast-forwards that branch.
- Keep the machine awake (`caffeinate -dims` on a Mac). In Pi Web mode, keep the Pi Web server running. In terminal mode nothing needs to stay open: the runner and its items are background processes.
- One queue per repo at a time. You can discuss the next task while one runs, but keep draft files outside the active checkout. Its handoff must wait until the queue is free.

## Plugin regression tests

From the collection root, `pnpm test` exercises the broker, parsing, installation, real resource loading and supervised temporary-repository workflows with fake CLI/Web agents. No model calls or application tests. Route it through your check broker when installed.

## Requirements

- Pi (tested with 1.5.0, terminal or Pi Web), Node 22.19+, `git`
- Pi Web is optional, found automatically when running (`piWebUrl` to point at one; `PI_WEB_PASSWORD` if it has a password)
- `pi` on your login shell's PATH (or set `piCommand`)
