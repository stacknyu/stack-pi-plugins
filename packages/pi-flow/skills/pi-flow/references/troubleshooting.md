# Troubleshooting

Each of these was hit in real use.

**The queue stops right away: "checks fail before any change".**
The checks fail on today's code, so every item would fail. `/queue problem` shows the output and a diagnosis.
- **"Missing script" / "pnpm recursive exec failed":** the check names a script that doesn't exist. `/task setup` only offers commands that ran successfully; re-run it after scripts change.
- **Passes in your folder but fails in a fresh worktree:** git-ignored files are missing (`.env`, generated types, another package's build output). List env files in `copyFromRepo`, or add the build to `setup`.
- **Fails everywhere:** the code itself is broken. Fix that first, or drop the command from `checks`.

**Checks behave differently when started from Pi Web.** Pi Web is a Node/pnpm process and leaks `npm_*`/`PNPM_*`/`NODE_ENV` variables. pi-flow strips them before setup and checks; if a tool needs one of them, set it inside the check command.

**"Working tree is not clean".** The queue fast-forwards your branch, so it needs a clean tree. Commit or stash your edits. The handoff commits only the plan folder.

**Edits made by hand in a worktree disappear.** Each worktree is reset to the branch tip before every item. Put fixes on the branch (commit in your main folder) or in `setup`/`copyFromRepo`.

**Many items are BLOCKED with "not built yet / absent / still uses the old …".** They ran before their prerequisites. pi-flow defers such items and retries them after the rest. If the run ended anyway, ask the manager: "retry everything that was blocked by missing prerequisites". For future plans, tag `[after: …]`.

**A check fails with "no changes were made".** Only in old plans without `[check]`. Tag verification items `[check]` and they pass when nothing needs changing.

**Parked items run one at a time at the end.** Parked items (after a conflict or a deferral) wait for quiet so they don't conflict again. To speed up: `unpark`, or `next <ids>`.

**The run stopped with "5 failures in a row".** That's the safety stop. Read the reasons (`queue_overview`, or "what's wrong?" to the manager), deal with the shared cause, then `retry` and `start`.

**You continued a failed item by hand and another item clashed with it.** When an item fails, its worktree goes to the next item. Don't keep working in a failed item's session; `retry` it, or raise its limits through the queue.

**Size limits keep blocking an item.** Limits rise by themselves (`NEEDS`, escalation, split). "bypass limits" in its session lifts them for that item, and `[big]` or `[files= lines= min=]` in its line starts it higher.

**`/queue` exists twice, or behaves oddly.** The old pi-queue package is still installed next to pi-flow. Remove it (`pi remove -l ./.pi/pi-queue` or the personal entry) and reload.

**Pi Web shows a stray "w0" project.** Sessions of a removed worktree lose their grouping. `/task cleanup --all` keeps worktrees while item sessions exist. Delete those sessions (`/task cleanup`) before removing worktrees.

**Pi Web asks for a password / "401".** Start Pi Web with `PI_WEB_PASSWORD` set in the environment the queue sees, or put `piWebPassword` in `.pi-queue/config.json`.

**Pi Web isn't used although it runs.** The runner looks for Pi Web's run records and port 30141. Set `piWebUrl` in `.pi-queue/config.json` if yours differs. `runIn: "web"` refuses to start without it, and `"cli"` never uses it.

**Nothing happens overnight.** The Mac slept (`caffeinate -dims`), or Pi Web was closed in Pi Web mode. The runner continues from `state.json` when started again.

**Parallel items rerun the same tests and the machine crawls.** Install pi-check (a separate plugin). The queue then sends every check through one shared broker per repo. Results are cached by file content and shared by all worktrees, identical runs in progress are joined, and heavy runs are throttled. Go failures that already fail on the base branch stop blocking items. See `/check status` for what runs and how much time was saved.
