# Stack Pi Plugins

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
pi install git:github.com/stacknyu/stack-pi-plugins@v0.2.0
```

### Update detection and upgrades

Both plugins are one native Pi package. With the unpinned install above, Pi's interactive terminal checks for remote Git changes at startup and notifies you; it does **not** automatically install updates. Offline mode disables the check. Explicit refs (including `@main`, tags and commits) and local-path installs are excluded from automatic notifications. Pi Web/SDK hosts control their own notification UI; terminal startup notices are not automatically inherited.

After active queues/checks finish, update explicitly:

```sh
pi update git:github.com/stacknyu/stack-pi-plugins  # this collection
# or: pi update --extensions                     # all installed packages
```

Bare `pi update` updates Pi itself, not its packages. Restart Pi after updating; restart the idle pi-check broker too when its code changed. `/reload` alone does not replace a running broker or queue process.

Git notifications compare commits, not `package.json.version`. The root version and matching `CHANGELOG.md` entries let Pi show **Extension Updates** on a fresh launch after an upgrade; first installs only record the version. Pinned tags stay on their tag; install a newer tag explicitly to upgrade. Explicit branch refs can move when manually updated despite skipping notifications. See Pi's [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and [update commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#update-pi-or-packages).

Use `pi config` to select extensions and skills. Disabling pi-check does not erase its discovery registry; set `"checkBroker": false` in a project's `.pi-queue/config.json` if pi-flow must not use it.

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

Use pnpm 12.14.0 (the version in `package.json`). Tests use temporary repositories and fake workers; they do not call models. Run them locally before pushing; this repository has no GitHub Actions workflows.

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

For each release, bump the root version and move its notes from `Unreleased` to a matching numeric heading (for example `## 0.3.0`) in `CHANGELOG.md`. Update the lockfile when dependencies change, and run `pnpm test` locally. Review and merge the changes, then create an immutable tag on the tested commit:

```sh
git tag -a v0.3.0 -m 'v0.3.0'
git push origin main v0.3.0
```

The root version/tag is Pi's release and changelog identity for the whole collection. Child manifests describe internal packages, not independently published Pi releases. Never move an existing release tag. `private: true` prevents accidental npm publication; it does **not** make this GitHub repository private or prevent Pi Git installation. No npm release service is needed.

## License

[MIT](LICENSE) — Copyright 2026 Stacknyu.
