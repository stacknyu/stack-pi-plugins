# Work items

## Line format

```
- [ ] A01 — <what to do, naming files/functions>. Done when: <observable result>. [areas: <folders/files it changes>] [after: <ids>]
```

- **Id:** capital letters plus a number (`A01`, `P03`, `V04`), unique. File order breaks ties, not dependencies. Ids made by the queue: `A01a…` (split parts), `V01-fix1…` (gap fixes).
- **Done when:** what a reviewer can verify. Every item needs one.
- **Context:** each item runs in a fresh session that has never seen the planning chat. It reads `AGENTS.md`, `brief.md`, `rules.md`, the answers in `questions.md`, and the map and inventory parts it names. Anything it needs must be there or in its line.

## Tags

| Tag | Meaning |
|---|---|
| `[areas: a, b]` | folders/files the item changes. Items with overlapping areas never run at the same time; disjoint ones run in parallel. Required. |
| `[after: A01, A02]` | wait until these pass. If one fails, this item fails without running. `[after: *]` waits for everything else. |
| `[check]` | a verification item (see below) |
| `[big]` | start at the `big` limits (15 files / 600 lines / 90 min) |
| `[files=12 lines=400 min=60]` | start at these limits |
| `[tier: light]` | a named preset from `task.json` `"tiers"` (model, thinking, optional limits). Use `light` for mechanical edits, `standard` for feature work, `heavy` for design/security/migrations/final checks |
| `[model: provider/model-id]` | exact model for one item; wins over the tier |
| `[thinking: medium]` | supported thinking level selected during planning; otherwise queue default |

## Plan session choices upfront

The planner receives the authenticated model catalog, supported thinking levels and advertised costs. Choose a sufficient model/effort for each item according to complexity and risk, honoring user preferences; explain the choices briefly in `rules.md`. Routine localized edits need not use the strongest model. Security, migrations, cross-cutting changes and final verification deserve stronger reasoning. Price is not a speed benchmark.

`task.json` may set default `model` and `thinking`; item tags override those defaults. Handoff rejects unavailable models and unsupported thinking levels before running checks or committing. Legacy untagged items retain queue defaults. Both CLI and Pi Web session creation use the resolved pair; automatically generated split/fix items inherit their parent's selection. No mid-run model guessing or automatic fallback.

## What the runner judges

An item passes only if:
- it changed files only under `allowedPaths`
- it stays within its size limits: net added lines (`maxNetLines`, 150) and files gaining lines (`maxFilesGrowing`, 5)
- every check command passes

Coding workers write focused regressions but leave mandatory configured suites to the runner's verification phase. If a check fails, the agent gets `fixRounds` (1) chances in the same session. Failed work is kept on `queue-failed/<id>`. A parent whose automatic repairs already completed its change may pass without another edit, after inspecting its acceptance criteria and passing the same checks.

## Sizes adjust themselves

1. An agent that sees the item is bigger replies `NEEDS: 20 files, 900 lines`. The runner jumps to the first `escalate` level that fits (15/600 → 40/1500 → 200/5000) and the same agent carries on.
2. An agent that stops on size, or whose change overflows, gets the next level.
3. Typing "bypass limits" in a running item's session lifts size limits for that item.
4. Past the last level, the same agent **splits** the item into 2–4 parts (`A01a…`, `splitMax`), with their own areas and `[after]` order. Parts are not split again. Only size causes a split: a `BLOCKED` item is never split.

Task-wide starting limits belong in `task.json`: `"limits": {"maxNetLines": 400, "maxFilesGrowing": 10, "itemMinutes": 60}`. That is the only place a "use higher limits" request takes effect for every item.

## The queue's growth budget

Everything the queue adds by itself (split parts beyond their parent, gap fixes, repairs) counts against one budget: `growthMax`, by default max(8, 30% of the planned items). When it is used up nothing more is split or added; the item fails as "needs you". A queue of 89 items can therefore reach about 116, never 300.

## Re-queuing

- **Waiting:** a worker that needs another item's work replies `WAITING: A03, B02 — <what is missing>`. The item is queued again after those items; nothing fails. After `maxWaits` (3) rounds, or when the named items are done or unknown, it counts as BLOCKED.
- **Already done:** `ALREADY DONE: <evidence>` with no changes passes when the checks pass, so an item another item already covered does not fail its dependents.
- **Blocked:** `BLOCKED: decision: <question>` and `BLOCKED: env: <what>` go straight to you (`/queue report`, or `answer` through the manager). Any other `BLOCKED` is deferred once while other work is pending, then fails; the automatic manager may retry it with a diagnosis.
- **Conflict:** an item whose change no longer fits the moved branch is redone at once on the latest code, in the same session (`REDO`). If it conflicts again it is parked and retried at the end.
- **Parked items** (conflicts, deferred) keep lower priority, but disjoint ready items can run together. Deferred retries first wait for runnable first-pass work to finish, without waiting on their own blocked dependents. Areas and dependencies still apply; `unpark` or `next` raises their priority (see manager.md).
- **Capacity:** up to `parallel` coding workers and `parallel` verifying/integrating items in worktree mode. A worker returning from checks to fix code reacquires coding capacity. Dependencies and area locks stay held until completion; direct-repo mode remains serial. A conflict does not reduce global concurrency.

## [check] items

- Verify instead of build. Give them `[after: <items they verify>]`. Their sessions use verification capacity, leaving coding capacity available for independent implementation.
- Pass **without changes** when everything holds. The log reads `PASS V01 · checked, nothing to change`.
- May fix tests, fixtures and docs inside the allowed paths.
- Report production gaps as lines: `GAP: <what is wrong and what to change>. Done when: … [areas: …]`. The queue merges gaps on overlapping areas and adds at most `maxGapItems` (3) fix items `V01-fix1…` per round, then checks again, up to `gapRounds` (2) rounds, within the growth budget.
- **Recheck:** a passed check runs again automatically when an item it covers changes later, meaning its `[after]` names that item or their `[areas]` overlap (`RECHECK` in the log).
- `BLOCKED` when it cannot check at all, for example with no test environment.

## Good plans

- Use `[after]` only for real prerequisites, not blanket stage barriers. Ready prerequisites on longer chains get preference; independent work stays parallel. Cycles and duplicate tags are rejected.
- Narrow, accurate `[areas]`. They decide parallelism and prevent conflicts.
- One coherent change per item, worth roughly 10–40 minutes of agent work. Every item costs a full session. Never make a trivial edit (copy text, a label, a rename) its own item: fold such edits into one item per screen/module. Items that change exactly the same files and do not depend on each other must be one item.
- Few `[check]` items: one per area or milestone plus a final `[after: *]`.
- The handoff lints the plan and refuses it until findings are fixed or `"planLint": "accept: <reason>"` is set: items to merge, an item naming another without `[after]`, and areas so broad that the plan runs one at a time.
- No items that only investigate or review: every item builds something or is a `[check]`.
- No item may depend on an unanswered question.
