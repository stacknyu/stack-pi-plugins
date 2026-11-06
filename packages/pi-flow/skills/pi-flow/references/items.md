# Work items

## Line format

```
- [ ] A01 — <what to do, naming files/functions>. Done when: <observable result>. [areas: <folders/files it changes>] [after: <ids>]
```

- **Id:** capital letters plus a number (`A01`, `P03`, `V04`), unique, in run order. Ids made by the queue: `A01a…` (split parts), `V01-fix1…` (gap fixes).
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
| `[model: provider/model-id]` | exact model selected during planning; otherwise queue default |
| `[thinking: medium]` | supported thinking level selected during planning; otherwise queue default |

## Plan session choices upfront

The planner receives the authenticated model catalog, supported thinking levels and advertised costs. Choose a sufficient model/effort for each item according to complexity and risk, honoring user preferences; explain the choices briefly in `rules.md`. Routine localized edits need not use the strongest model. Security, migrations, cross-cutting changes and final verification deserve stronger reasoning. Price is not a speed benchmark.

`task.json` may set default `model` and `thinking`; item tags override those defaults. Handoff rejects unavailable models and unsupported thinking levels before running checks or committing. Legacy untagged items retain queue defaults. Both CLI and Pi Web session creation use the resolved pair; automatically generated split/fix items inherit their parent's selection. No mid-run model guessing or automatic fallback.

## What the runner judges

An item passes only if:
- it changed files only under `allowedPaths`
- it stays within its size limits: net added lines (`maxNetLines`, 150) and files gaining lines (`maxFilesGrowing`, 5)
- every check command passes

If a check fails, the agent gets `fixRounds` (1) chances in the same session. Failed work is kept on `queue-failed/<id>`.

## Sizes adjust themselves

1. An agent that sees the item is bigger replies `NEEDS: 20 files, 900 lines`. The runner jumps to the first `escalate` level that fits (15/600 → 40/1500 → 200/5000) and the same agent carries on.
2. An agent that stops on size, or whose change overflows, gets the next level.
3. Typing "bypass limits" in a running item's session lifts size limits for that item.
4. Past the last level, the same agent **splits** the item into 3–8 parts (`A01a…`), with their own areas and `[after]` order. They run next. Parts are not split again.

## Re-queuing

- **Deferred:** an item that says `BLOCKED` while other work is still pending is retried after that work. This catches the most common case, a prerequisite that hasn't run yet. A second BLOCKED with nothing left that could help is a failure for you (a missing decision, contract or environment).
- **Conflict:** an item whose change no longer fits the moved branch is redone at once on the latest code, in the same session (`REDO`). If it conflicts again it is parked and retried at the end.
- **Parked items** (conflicts, deferred) run only when nothing else is running, one at a time. `unpark` or `next` lets them run normally (see manager.md).

## [check] items

- Verify instead of build. Give them `[after: <items they verify>]`.
- Pass **without changes** when everything holds. The log reads `PASS V01 · checked, nothing to change`.
- May fix tests, fixtures and docs inside the allowed paths.
- Report production gaps as lines: `GAP: <what is wrong and what to change>. Done when: … [areas: …]`. The queue adds fix items `V01-fix1…` before the check and checks again after them, up to `gapRounds` (2) rounds.
- **Recheck:** a passed check runs again automatically when an item it covers changes later, meaning its `[after]` names that item or their `[areas]` overlap (`RECHECK` in the log).
- `BLOCKED` when it cannot check at all, for example with no test environment.

## Good plans

- Foundations first, with real `[after]` dependencies only.
- Narrow, accurate `[areas]`. They decide parallelism and prevent conflicts.
- One coherent change per item. Splitting artificially is worse than one `[big]` item.
- No items that only investigate or review: every item builds something or is a `[check]`.
- No item may depend on an unanswered question.
