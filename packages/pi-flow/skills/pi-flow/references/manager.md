# The manager

`/task manage` makes the current chat the queue's manager. In Pi Web it is pinned. It acts **only on what the user asks in each message**; it never starts work on its own and never loops.

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

While the queue runs, changes go through an inbox (`.pi-queue/control.json`) that the runner applies within seconds, each logged as a `CONTROL` line. When it is not running they apply directly, and `start` acts on them.

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
