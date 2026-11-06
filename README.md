# Stack Pi Plugins

[![CI](https://github.com/stacknyu/stack-pi-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/stacknyu/stack-pi-plugins/actions/workflows/ci.yml)

Stacknyu's collection of plugins for the [Pi coding agent](https://github.com/earendil-works/pi).
One repository, one install, separate plugin folders.

| Plugin | What it does | Commands |
| --- | --- | --- |
| [pi-flow](packages/pi-flow/README.md) | Plans large tasks and runs a queue of fresh agent sessions with checks and commits | `/task`, `/queue` |
| [pi-check](packages/pi-check/README.md) | Shares and caches tests, type checks and lint across sessions and worktrees | `/check`, agent `check` tool |

## Install

Requires Pi, Node.js **22.19+**, Git, and macOS or Linux. Tested against Pi 1.5.0. Pi Web is optional.

```sh
pi install git:github.com/stacknyu/stack-pi-plugins
```

Restart Pi (or `/reload`). The plugins and their skills are available in every project. For a project-only installation, add `-l` from that project and commit its `.pi/settings.json`; teammates must trust the project before it loads. A personal install is simplest for pi-flow's worker worktrees.

For a pinned team release:

```sh
pi install git:github.com/stacknyu/stack-pi-plugins@v0.1.0
```

Unpinned installs follow the default branch when updated:

```sh
pi update git:github.com/stacknyu/stack-pi-plugins
```

Pinned installations stay on their tag; install a newer tag explicitly to upgrade. Use `pi config` to select extensions and skills. Disabling pi-check does not erase its discovery registry; set `"checkBroker": false` in a project's `.pi-queue/config.json` if pi-flow must not use it.

**Already using local copies?** Remove their package declarations before enabling this bundle, or commands/tools may load twice. Wait for active queues and checks to finish before switching copies. `/check reload` reloads configuration, not running broker code. This repository does not migrate existing installations automatically.

## Start using it

In your application's Git repository:

- `/check run all` runs detected checks. Your project still needs its own language tools and dependencies.
- `/task setup` detects the stack and verifies checks. **It can install profile plugins, edit `AGENTS.md`/Pi settings and commit setup changes.** Review the [pi-flow guide](packages/pi-flow/skills/pi-flow/references/guide.md) first.
- `/task <request>` plans a task and asks its questions before handing it to the queue.
- `/skill:pi-flow` and `/skill:pi-check` load the detailed guides.

Extensions run with your user permissions. pi-flow executes commands, creates worktrees and commits work; cleanup can remove task sessions and failed branches. pi-check runs project check commands and keeps local cache/state. Review the source and use trusted repositories. No credentials are distributed with this package.

## Develop locally

```sh
git clone https://github.com/stacknyu/stack-pi-plugins.git
cd stack-pi-plugins
pnpm install --frozen-lockfile
pnpm test
```

Use pnpm 12.14.0 (the version in `package.json`). Tests use temporary repositories and fake workers; they do not call models. CI runs the same suite on macOS/Linux with Node 22/24.

To use your checkout, remove the Git installation first, then:

```sh
pi install /absolute/path/to/stack-pi-plugins
```

Local installs read your checkout directly. Edit the plugin and restart Pi or `/reload`. For pi-check broker changes, let active checks finish and stop the idle broker before loading new code. The standalone CLI is `node packages/pi-check/cli.mjs`; a Git package install does not promise a global `pi-check` executable.

### Add a plugin

1. Add `packages/<plugin>/` with `package.json`, an extension entrypoint and README; include `skills/` when needed.
2. List its entrypoint and skill directory explicitly in the root `package.json` under `pi`. Do not glob all source files as extensions.
3. Declare host-provided Pi packages as peers, not runtime dependencies. Add actual runtime dependencies at the appropriate manifests and verify a production-only Git install.
4. Add `*.test.mjs` tests, run the suite, and document the plugin above.

Keep plugins independent. Preserve each plugin's internal relative paths; do not commit caches, credentials, local profiles or task sessions.

### Release

Open a pull request and let CI pass. Update the root version and `CHANGELOG.md`, refresh the lockfile with `pnpm install`, merge, then tag the tested commit:

```sh
git tag -a v0.2.0 -m 'v0.2.0'
git push origin main --follow-tags
```

The root version/tag identifies the collection. Child package versions identify the bundled plugins. `private: true` prevents accidental npm publication; it does **not** make this GitHub repository private or prevent Pi Git installation. No npm release service is needed.

## License

[MIT](LICENSE) — Copyright 2026 Stacknyu.
