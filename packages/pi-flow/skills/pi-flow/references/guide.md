# pi-flow guide

## The idea

Large work (hours) fails in one long agent session: context fills up, the agent drifts, and nothing checks its claims. pi-flow splits the work into a written plan and a list of small items. A queue gives every item a fresh session and has a script judge the result. You answer the plan's questions once, then watch or walk away.

## One-time install

- `pi install npm:@stacknyu/pi-flow` installs pi-flow personally for every repo. Optionally install the independent check plugin with `pi install npm:@stacknyu/pi-check`. Reload Pi / Pi Web.
- In a repo whose plugins you like: `/task save-profile`. That set becomes your profile.

## Per repo, once: `/task setup`

- Installs your profile's plugins into the repo (`pi install -l`).
- Detects the stack: pnpm/npm/yarn/bun workspaces, Go modules, Rust.
- Runs every typecheck, lint and build command **once on today's code**. Only commands that pass can become a task's checks. Failing ones are listed with their output in `.pi-flow/setup-report.md`.
- Adds a short managed block to `AGENTS.md` and removes stale harness blocks (old GLLA). It commits only `AGENTS.md` and `.pi/settings.json`, and only if you had no edits there.

## Per task

1. **`/task <request>`.** This chat becomes the planning session. It researches the code (subagents may search in parallel, read-only) and writes `.tasks/<slug>/`:

   | File | Content |
   |---|---|
   | `brief.md` | goal, what "done" means, out of scope, risks |
   | `inventory.md` | facts from the code, with paths |
   | `map/<area>.md` | what changes per area, and what must not |
   | `rules.md` | task-specific rules |
   | `questions.md` | decisions only you can make |
   | `items.md` | the work list (see items.md) |
   | `task.json` | `allowedPaths`, `checks`, suggested `parallel` |

2. **Questions.** It asks them all in one message, each with a recommended answer. Reply in plain words.
3. **Handoff.** The planner calls `task_handoff`. It refuses until:
   - every question is answered
   - every item has an id, a "Done when" and `[areas]`
   - every `[after]` id exists and dependencies are acyclic
   - the checks pass on today's code
   - the tree is clean apart from the plan

   Then it commits `.tasks/<slug>/` and starts the queue. In Pi Web it pins this chat as the control room.
4. **The queue runs.** Up to `parallel` items at once, each in its own git worktree (`.pi-queue/worktrees/wN`) and its own fresh session. Each passing item is rebased onto the branch and fast-forwarded: one commit `ID: title`.
5. **Automatic supervision.** Once the baseline passes, a detached supervisor creates a chat-only manager. Healthy 60-second ticks make no model calls. Bounded recovery and human-only blockers are defined in manager.md. `/task manage` and `/queue …` remain available for manual intervention.
6. **Clean up.** Finished item sessions are removed when the run ends. `/task cleanup` removes failed items' sessions and the planning chat. `--all` also removes worktrees and `queue-failed/*` branches.

## Optional fresh-context plan review

Before handoff, the planner is instructed to use one fresh read-only reviewer for consequential plans (cross-component contracts, permissions, billing, migrations, destructive changes or architectural uncertainty), or when you ask. Routine localized work skips it; you can say "skip plan review". No new command is needed.

The reviewer gets the written plan and selected code references, not the planning conversation. It first paraphrases the intended change and current behavior, then reports at most three consequential gaps with paths and rationale. No file edits, check runs, queue controls, extra agents, style nits or speculative features. The planner verifies findings, updates the existing plan, and asks you about any new decisions or safety trade-offs. A short status/disposition summary stays in `rules.md`; no extra report hierarchy or automatic repeat rounds.

This is planner guidance, not an enforced `task_handoff` gate or a correctness guarantee. Both native Pi and Pi Web need an available fresh-context subagent tool to perform it; pi-flow does not install one. Missing or failed delegation is recorded as "not run" and reported to you, never passed off as an independent review. If you explicitly require a completed review before execution, the planner must ask before proceeding without it. Fresh conversation context does not imply exclusion of host instructions or filesystem sandboxing. Scope, size, checks and code review remain unchanged.

## Terminal app versus Pi Web

Everything works in the plain terminal app. Pi Web is optional and found automatically.

| | Terminal | Pi Web |
|---|---|---|
| Items run as | background `pi --mode json` processes | real Pi Web sessions, live in the sidebar |
| Watch an item | `/queue log <id>`, the live panel | open `queue <id>: …` in the sidebar |
| Open a finished item | `/queue open <id>` (switches this chat to it) | sidebar |
| Sessions stored | `.pi-queue/sessions/` | Pi Web's store |
| Cleanup | deletes the files | Pi Web API (delete or archive) |
| Planning chat | — | pinned while the queue runs |

## Files

| Path | In git | What |
|---|---|---|
| `.tasks/<slug>/` | yes | the plan, which is what every item reads |
| `.pi-flow/` | no | `repo.json` (verified checks), `setup-report.md`, `status.json` |
| `.pi-queue/config.json` | no | queue settings (your edits survive across tasks) |
| `.pi-queue/log.md` | no | one line per event: PASS, FAIL, SPLIT, GAPS, DEFERRED, RECHECK, REDO, WIDTH, CONTROL, END |
| `.pi-queue/state.json` | no | done, failed, parked, splits, fixes, sessions; a restart continues from here |
| `.pi-queue/manager.json` | no | manager session, approval identity, incident and recovery budgets |
| `.pi-queue/control/` | no | atomic control inbox; one file per request |
| `.pi-queue/notes/<id>.md` | no | each item's result and the agent's last reply |
| `.pi-queue/live/<id>.log` | no | each item's activity |
| `.pi-queue/archive/` | no | earlier runs' records |

## While it runs

- `/queue pause` stops new dispatch and lets running items finish normally. `/queue start` resumes. `/queue stop` still aborts running items and preserves their work; use pause for upgrades.
- Agent parallelism and pi-check's CPU/job budgets are independent. Planning and manager controls accept more than eight agents; choose based on independent work and available memory/provider capacity, not test-process count.
- Don't commit to the task's branch or edit files in the repo folder. The queue fast-forwards that branch.
- Keep the machine awake (`caffeinate -dims` on a Mac). In Pi Web mode, keep the Pi Web server running.
- One queue per repo at a time. You can discuss the next task meanwhile, but keep draft files outside the active checkout. Its handoff must wait until the queue is free.
