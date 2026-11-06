# Changelog

## Unreleased

- pi-flow: automatic isolated manager with a detached, no-model health tick and bounded approved-scope recovery; durable controls, explicit resume, worker quarantine and preserved failure work.
- pi-flow: reject dependency cycles and conflicting tags; prioritize critical-path prerequisites without serializing independent work; expose installed pi-check in worker worktrees.
- pi-check: correct shared-result invalidation and cancellation, reserve capacity for staggered heavy jobs, and preserve Go execution semantics and language-specific inputs. Fix symlinked CLI entrypoints and isolated-profile discovery.
- Add temporary-repository, fake-agent and real-resource-loader regressions. No active installations are migrated automatically.

- Remove GitHub Actions CI; verification remains available locally through `pnpm test` and pi-check.

## 0.1.0

- First standalone collection of Stacknyu's Pi plugins.
- Includes pi-flow (task planning and queued implementation) and pi-check (shared, cached verification), with their existing tests and skills.
- Adds Git installation, local development instructions, and CI.
- Uses the documented TypeBox import for standalone Node tests and Pi loading.
