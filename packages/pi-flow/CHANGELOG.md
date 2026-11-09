# pi-flow changelog

## 1.5.2

- Add optional fresh-context plan-review guidance: one read-only reviewer paraphrases consequential plans and reports up to three evidence-backed gaps before handoff.
- Honor review opt-outs and explicit review requirements; report unavailable or failed delegation honestly and keep dispositions in the existing plan without automatic repeat rounds.
- Document native Pi/Pi Web host limits and add prompt-contract regressions. Queue execution, worker backend settings and enforced handoff gates remain unchanged.

## 1.5.1

- Support Pi Web 0.15.0 session-history results, including compaction, fresh-answer validation and nested subagent completion/abort checks; preserve native CLI workers.
- Isolate live queue widgets per session, honor Web cleanup refusals, retain retryable cleanup, and batch delete/archive requests within Web's 500-session limit.
- Explain cancelled or unsupported session navigation and add native/RPC/Web compatibility regressions.

## 1.5.0

- First standalone public npm package, `@stacknyu/pi-flow`, maintained in the Stack Pi Plugins monorepo. pi-check remains optional and is not installed as a dependency.
- Includes approved-scope automatic supervision, durable queue controls, worker ownership protection, dependency-aware scheduling and optional pi-check worktree integration from the collection's v0.2.0 release.
- Ships its own Pi extension, skill, release notes and runtime files; supports independent Pi-managed updates.
