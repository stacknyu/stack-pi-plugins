---
name: pi-flow
description: How pi-flow plans and runs large tasks with a queue of fresh Pi sessions (/task, /task manage, /queue, items.md format, [check]/[areas]/[after] tags, limits, re-queuing, cleanup, troubleshooting). Use when planning a /task, managing or explaining the queue, answering how pi-flow works, or diagnosing a queue problem.
---

# pi-flow

pi-flow turns a large request into a planned work list that a queue of fresh, unattended Pi sessions implements item by item. A script judges every item; each passing item becomes one commit.

Read the reference that fits the question:

- `references/guide.md`: the whole workflow (setup → plan → questions → handoff → queue → cleanup), the terminal app versus Pi Web, and the files involved. Start here when explaining pi-flow.
- `references/items.md`: the items.md line format, every tag (`[areas]`, `[after]`, `[check]`, `[big]`, size tags), the size limits and how they rise, splitting, gap fixing, deferral, rechecks. Read it before writing or changing a plan.
- `references/manager.md`: what the manager chat does, its tools and actions (retry, recheck, rerun, unpark, next, add, parallel, stop, start), how to diagnose a run, and the rules it follows. Read it when acting as the manager.
- `references/troubleshooting.md`: known problems and their fixes (failed baseline, dirty tree, items blocked by missing prerequisites, parked items running one by one, stray Pi Web projects, and more). Read it when something went wrong.

Rules that always hold:
- The runner, not an agent, decides whether an item passes: scope (allowed paths), size limits, checks.
- Queue items never ask questions, never commit, and never use the queue tools.
- The manual manager acts only when asked. The isolated automatic manager may propose retries and targeted repair items under upfront task recovery authority; see references/manager.md. Neither manager edits code, reverts commits or deletes branches.
