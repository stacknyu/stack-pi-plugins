# The manager

## Automatic manager

After an approved handoff passes its baseline, a detached supervisor watches the queue and creates a dedicated manager session when intervention is needed. It survives closing the planning terminal/chat. In Pi Web the manager is pinned; in terminal mode its session is in `.pi-queue/sessions/`, with its ID/reply in `.pi-queue/manager.json`.

- Runner failure/lifecycle events wake the supervisor immediately; a 60-second filesystem/process tick is the fallback. Healthy work makes **no model calls**.
- Failures can be diagnosed while independent workers continue. New incidents do not wait ten minutes. Events arriving during a review remain pending; a busy or temporarily failed manager defers intervention rather than silently abandoning supervision. Unchanged resolved/rejected incidents are not prompted repeatedly.
- The manager is chat-only, with no tools or extension capabilities. It proposes exact failed-item retries, narrowly scoped repair items, or a clean runner restart. Code validates proposals and live target ownership; the runner alone applies controls. Workers receive the failure evidence and diagnosis, not the planning conversation.
- Agree `task.json.recovery` upfront: recommended `{"maxAttempts":2,"maxRepairs":4,"maxRestarts":2}`. Attempts are per failed item; repairs and clean restarts are task-wide. Handoff accepts integers 0–5 / 0–20 / 0–5, including zero to disable an action. Budgets are persisted before dispatch and survive supervisor restarts. Legacy plans without this authority retain two retries/two restarts but cannot create repair items.
- One repair proposal targets one original failed item with up to three concrete work lines. Repairs must fit both its original areas and task allowed paths, inherit checks/model/size limits, and run before the original item is attempted again. Repairs cannot spawn further repairs. No changed checks, guessed provider/model, new goal, destructive reset or fabricated credentials.
- Manual pause/stop, changed approval/configuration and uncertain target ownership prevent recovery. Missing decisions/credentials and exhausted budgets remain recorded failures; they do not freeze independent safe work. Quarantined work is preserved, never reclaimed automatically.
- A crash with recorded workers quarantines their worktrees: no reset, cleanup or automatic orphan reclamation. Quiet tests/provider retries are not treated as hangs.
- Set `manager: false` in `.pi-queue/config.json` to disable automatic management. A direct `node runner.mjs` invocation is unsupervised; normal handoff and `/queue start` launch the supervisor.
- Models requiring a custom provider extension cannot run in the isolated chat-only manager; configure an available built-in/configured provider. No model fallback is guessed.

## Manual manager

`/task manage` makes the current chat a separate interactive manager. In Pi Web it is pinned. This chat acts **only on what the user asks in each message**; the automatic supervisor does not prompt it.

## Tools

| Tool | What |
|---|---|
| `queue_overview` | counts, running items, failed items with reasons, parked and open items, recent log |
| `queue_item` | one item: its line, status, commit (files changed), last result, activity |
| `queue_control` | `stop`, `start`, `retry`, `recheck`, `rerun`, `unpark`, `next`, `add`, `parallel` |

`ids` are item ids or prefixes: `V04` matches `V04a…V04h`. Empty ids means all.

| Action | Effect |
|---|---|
| `retry` | failed or parked items run again |
| `recheck` | passed `[check]` items run again |
| `rerun` | passed items run again (their commits stay; the new run builds on top) |
| `unpark` | parked/deferred items run normally, in parallel, without waiting for the end |
| `next` | these items run next: un-parked and moved to the front; dependencies and overlapping areas still apply |
| `add` | new work-list lines, only lines the user agreed to (kept in state; the plan file is not edited) |
| `parallel` | how many run at once. Works while running; the number becomes the ceiling and is saved for the next start |
| `stop` / `start` | stop the run (running items' work kept on branches) / start it |

Controls go through atomic files in `.pi-queue/control/`. The runner alone applies them, within seconds while running or on the next start otherwise; applied actions are logged. `/queue pause` lets current workers finish; `/queue stop` aborts them and preserves work. Only an explicit `/queue start` clears those markers. Wait for the old runner/supervisor to exit before starting.

The same actions exist as commands: `/queue retry [id]`, `/queue recheck [id]`, `/queue rerun <id>`, `/queue unpark`, `/queue next <ids>`, `/queue parallel <n>`.

## Diagnosing

1. `queue_overview` first. Group failures by cause; many failures often share one.
2. Typical causes:
   - **A check or consumer ran before what it depends on.** The reasons say "not built yet", "absent", "still uses the old …". Fix: `retry` once the prerequisites pass, or `next` the prerequisites. Plans should tag `[after]`.
   - **A real gap the plan missed.** Propose items, and `add` them after the user agrees.
   - **A decision or contract question.** Tell the user plainly what must be decided.
   - **Environment** (no test endpoint, credentials, a broken test suite). The user must provide it, or the item should be dropped.
   - **The size limit.** That handles itself. If it keeps failing, suggest splitting the item.
3. Explain in a few lines: what is wrong, why, and what you would do. Act only when asked.

## Rules

- Never edit code, revert commits or delete branches. If that is needed, say so.
- Never add items the user did not agree to.
- Queue items cannot use these tools (they refuse inside `.pi-queue/worktrees/` and in sessions named `queue …`).
