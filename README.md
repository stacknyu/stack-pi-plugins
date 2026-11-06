# Stack Pi Plugins

Independent plugins for the [Pi coding agent](https://github.com/earendil-works/pi), maintained in one repository. Each has its own npm package, version, changelog and update lifecycle.

| Package | What it does | Commands |
| --- | --- | --- |
| [@stacknyu/pi-flow](packages/pi-flow/README.md) | Plans large tasks and runs checked, committed work in fresh agent sessions | `/task`, `/queue` |
| [@stacknyu/pi-check](packages/pi-check/README.md) | Shares and caches tests, type checks and lint across sessions and worktrees | `/check`, agent `check` tool |

## Install independently

Requires Pi, Node.js **22.19+**, Git, and macOS or Linux. Tested against Pi 1.5.0. Pi Web is optional.

```sh
pi install npm:@stacknyu/pi-flow    # only task planning and queues
pi install npm:@stacknyu/pi-check   # only shared checks
```

Run either command, or both. Neither package depends on the other. Restart Pi or `/reload` after installing. When both are loaded, pi-flow discovers pi-check automatically.

For project-only installation, add `-l` from that project and commit its `.pi/settings.json`; teammates must trust the project before it loads. A personal install is simplest for pi-flow's worker worktrees. To pin a release, append its exact version, for example `npm:@stacknyu/pi-flow@1.5.0`.

### Update and remove independently

```sh
pi update npm:@stacknyu/pi-flow
pi update npm:@stacknyu/pi-check
# or: pi update --extensions      # all installed packages

pi remove npm:@stacknyu/pi-flow   # leaves pi-check installed
pi remove npm:@stacknyu/pi-check  # leaves pi-flow installed
```

Pi's interactive terminal checks unpinned npm packages for newer versions at startup and notifies you; it does **not** automatically install updates. Exact versions, local paths and offline mode disable these checks. Each package's versioned `CHANGELOG.md` provides its own **Extension Updates** notes on a fresh launch after an upgrade; first installs only record the version. Pi Web/SDK hosts control their own notification UI.

Bare `pi update` updates Pi itself, not its packages. Before upgrading/removing either plugin, let active queues/checks finish. Restart Pi after updating; restart the idle pi-check broker too when its code changed. `/reload` does not replace a running broker or queue process, and `/check reload` reloads configuration rather than code.

See Pi's [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and [update commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#update-pi-or-packages). If pi-flow must not use a previously discovered pi-check installation, set `"checkBroker": false` in `.pi-queue/config.json`.

### Migrate from the Git bundle or local copies

The original `git:github.com/stacknyu/stack-pi-plugins` installation remains compatible, but loads both plugins as one package. Do not enable it alongside the standalone npm packages: different package identities can register duplicate tools/commands.

After queues/checks finish, remove the old declaration, then install only the npm packages you want:

```sh
pi remove git:github.com/stacknyu/stack-pi-plugins
pi install npm:@stacknyu/pi-flow   # and/or pi-check
```

Use `pi list` to find old local-path declarations and remove those too. Match their original personal/project scope (`-l` for project-local removal). No existing installation is migrated automatically.

## Start using it

In your application's Git repository:

- pi-check: `/check run all` runs detected checks; your project still needs its language tools and dependencies.
- pi-flow: `/task setup` detects the stack and verifies checks. **It can install profile plugins, edit `AGENTS.md`/Pi settings and commit setup changes.** Review the [guide](packages/pi-flow/skills/pi-flow/references/guide.md) first.
- `/task <request>` plans a task and asks its questions before handing it to the queue.
- `/skill:pi-flow` and `/skill:pi-check` load the installed plugins' guides.

Extensions run with your user permissions. pi-flow executes commands, creates worktrees and commits work; cleanup can remove task sessions and failed branches. pi-check runs project check commands and keeps local cache/state. Review the source and use trusted repositories. No credentials are distributed with these packages.

## Develop locally

```sh
git clone https://github.com/stacknyu/stack-pi-plugins.git
cd stack-pi-plugins
pnpm install --frozen-lockfile
pnpm test
```

Use pnpm 12.14.0 (the root `package.json` version). Tests use temporary repositories/profiles and fake workers, not model calls. They pack and independently load the actual npm archives, checking included runtime files and absence of the sibling plugin. There are no GitHub Actions workflows.

Remove the corresponding managed installation before using a local checkout:

```sh
pi install /absolute/path/to/stack-pi-plugins/packages/pi-flow
pi install /absolute/path/to/stack-pi-plugins/packages/pi-check
```

Local installs read that directory directly; they do not get registry update notifications. Restart Pi or `/reload` after edits, and let active checks finish before restarting a changed broker. The standalone check CLI is `node packages/pi-check/cli.mjs`; a Pi-managed package does not promise a globally available `pi-check` executable.

## Release one plugin

1. Bump only that plugin's `packages/<plugin>/package.json` version and add a matching numeric heading to its `CHANGELOG.md`. Keep runtime files in its `files` allowlist; host-provided Pi dependencies remain peers. Never depend on sibling source paths.
2. Update the lockfile only when dependencies change. Run `pnpm test` locally through your check broker, review the diff, then commit it.
3. Log into npm with an account authorized for `@stacknyu`. Publish only the selected workspace from a clean checkout; pnpm carries the root MIT license into its archive. Complete npm's browser/2FA approval if requested.
4. Verify the registry version and package contents, then tag the published version and push. Never move a published tag or overwrite an npm version.

Example for the initial pi-flow release (pi-check uses its own name/version/tag):

```sh
pnpm --filter @stacknyu/pi-flow publish --access public
npm view @stacknyu/pi-flow version
git tag -a pi-flow/v1.5.0 -m '@stacknyu/pi-flow 1.5.0'
git push origin main pi-flow/v1.5.0
```

The root package stays private to prevent accidental npm publication of the bundle. Existing root `v0.x` tags identify historical Git collection releases; standalone releases use `pi-flow/v…` and `pi-check/v…`. Publishing is local and needs no CI service.

## License

[MIT](LICENSE) — Copyright 2026 Stacknyu.
