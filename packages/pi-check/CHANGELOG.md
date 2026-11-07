# pi-check changelog

## 1.1.1

- Run command helpers asynchronously so native Pi and Pi Web remain responsive; report failed, killed or truncated command results as warnings.
- Skip invisible status polling in print/JSON mode while retaining native/RPC status support and session-local shutdown behavior.
- Add isolated command and lifecycle compatibility regressions.

## 1.1.0

- First standalone public npm package, `@stacknyu/pi-check`, maintained in the Stack Pi Plugins monorepo. pi-flow is not installed as a dependency.
- Includes shared-result revalidation, cancellation fixes, staggered CPU allocation and Go execution/input correctness from the collection's v0.2.0 release.
- Ships its own Pi extension, skill, CLI, release notes and runtime files; supports independent Pi-managed updates.
