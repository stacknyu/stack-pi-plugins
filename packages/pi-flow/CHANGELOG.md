# pi-flow changelog

## 1.5.1

- Support Pi Web 0.15.0 session-history results, including compaction, fresh-answer validation and nested subagent completion/abort checks; preserve native CLI workers.
- Isolate live queue widgets per session, honor Web cleanup refusals, retain retryable cleanup, and batch delete/archive requests within Web's 500-session limit.
- Explain cancelled or unsupported session navigation and add native/RPC/Web compatibility regressions.

## 1.5.0

- First standalone public npm package, `@stacknyu/pi-flow`, maintained in the Stack Pi Plugins monorepo. pi-check remains optional and is not installed as a dependency.
- Includes approved-scope automatic supervision, durable queue controls, worker ownership protection, dependency-aware scheduling and optional pi-check worktree integration from the collection's v0.2.0 release.
- Ships its own Pi extension, skill, release notes and runtime files; supports independent Pi-managed updates.
