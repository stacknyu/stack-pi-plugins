# Changelog

## 0.4.1

- pi-flow 1.8.1: fixes items passing as DONE after dropping work to fit a size cap (no squeeze-to-fit fix round, lockfiles excluded from size, DONE confirmation, escape-hatch lint, config reset at handoff, checks always run).

## 0.4.0

- pi-flow 1.8.0: provider-outage waiting, autonomous decisions with a decision log, in-run slot recovery, merge checks outside the lock, overtime turn, start retries, persistent manager mode.

## 0.3.0

- pi-flow 1.7.0: bounded queue growth, WAITING/ALREADY DONE/BLOCKED kinds, automatic reconciliation of interrupted workers, model-free restarts and transient retries, plan limits/tiers and a plan lint at handoff, manager `answer`/`limits`/`skip`.
- pi-check 1.2.0: flaky-test reruns, measured scheduling lanes, tsgo, low-priority speculation.

## 0.2.0

- pi-flow: automatic isolated manager with a detached, no-model health tick and bounded approved-scope recovery; durable controls, explicit resume, worker quarantine and preserved failure work.
- pi-flow: reject dependency cycles and conflicting tags; prioritize critical-path prerequisites without serializing independent work; expose installed pi-check in worker worktrees.
- pi-check: correct shared-result invalidation and cancellation, reserve capacity for staggered heavy jobs, and preserve Go execution semantics and language-specific inputs. Fix symlinked CLI entrypoints and isolated-profile discovery.
- Add temporary-repository, fake-agent, real-resource-loader and native package-update regressions. No active installations are migrated automatically.
- Document Pi-native update notifications, explicit updates and versioned extension changelogs.
- Remove GitHub Actions CI; verification remains available locally through `pnpm test` and pi-check.

## 0.1.0

- First standalone collection of Stacknyu's Pi plugins.
- Includes pi-flow (task planning and queued implementation) and pi-check (shared, cached verification), with their existing tests and skills.
- Adds Git installation, local development instructions, and CI.
- Uses the documented TypeBox import for standalone Node tests and Pi loading.
