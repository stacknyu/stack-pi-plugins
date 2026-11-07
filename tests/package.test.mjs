import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const cli = fileURLToPath(new URL("./cli.js", sdk));
const runner = new URL("../packages/pi-flow/runner.mjs", import.meta.url).href;

for (const plugin of ["pi-flow", "pi-check", "pi-glitch-lab"]) test(`${plugin} npm archive loads independently with its own version, skill and license`, { timeout: 60000 }, (t) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), `stack-${plugin}-pack-`)));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const agentDir = join(home, "agent"), npmRoot = join(agentDir, "npm");
	const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	execFileSync("pnpm", ["--dir", join(root, "packages", plugin), "pack", "--pack-destination", home], { cwd: root, env, encoding: "utf8", stdio: "pipe", timeout: 30000 });
	const archive = join(home, readdirSync(home).find((f) => f.endsWith(".tgz")));
	const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
	for (const file of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", plugin === "pi-glitch-lab" ? "extensions/index.ts" : "extension.ts", `skills/${plugin === "pi-glitch-lab" ? "glitch-hunt" : plugin}/SKILL.md`]) assert.ok(files.includes(`package/${file}`), file);
	assert.equal(files.some((f) => /(?:\.test\.mjs|node_modules|\.env|\.npmrc)/.test(f)), false);
	const runtimeArchives = [];
	if (plugin === "pi-glitch-lab") {
		const require = createRequire(join(root, "packages", plugin, "package.json"));
		for (const dependency of ["playwright", "playwright-core"]) {
			const manifest = require.resolve(`${dependency}/package.json`);
			const packed = JSON.parse(execFileSync("npm", ["pack", join(manifest, ".."), "--pack-destination", home, "--json", "--ignore-scripts"], { cwd: home, env, encoding: "utf8", stdio: "pipe", timeout: 30000 }));
			runtimeArchives.push(join(home, packed[0].filename));
		}
	}
	execFileSync("npm", ["install", "--prefix", npmRoot, "--ignore-scripts", "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund", archive, ...runtimeArchives], { cwd: home, env, encoding: "utf8", stdio: "pipe", timeout: 30000 });
	assert.deepEqual(readdirSync(join(npmRoot, "node_modules/@stacknyu")), [plugin]);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:@stacknyu/${plugin}`] }));
	const installed = join(npmRoot, "node_modules/@stacknyu", plugin);
	const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	assert.equal(pkg.private, undefined);
	assert.equal(pkg.publishConfig.access, "public");
	const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(sdk)};
		import { parseChangelog } from ${JSON.stringify(new URL("./utils/changelog.js", sdk).href)};
		const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR) });
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		const entries = parseChangelog(${JSON.stringify(join(installed, "CHANGELOG.md"))});
		assert.equal([entries[0].major, entries[0].minor, entries[0].patch].join("."), ${JSON.stringify(pkg.version)});
		console.log(JSON.stringify({ errors, commands: extensions.flatMap(e => [...e.commands.keys()]), tools: extensions.flatMap(e => [...e.tools.keys()]), skills: loader.getSkills().skills.map(s => s.name) }));
	`], { cwd: home, env, encoding: "utf8", stdio: "pipe", timeout: 15000 }));
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.commands.sort(), plugin === "pi-flow" ? ["queue", "task"] : plugin === "pi-check" ? ["check"] : ["glitch-lab-doctor"]);
	assert.deepEqual(result.skills.sort(), plugin === "pi-glitch-lab" ? ["ai-agentic-usability-testing", "glitch-hunt"] : [plugin]);
	assert.equal(result.tools.includes("check"), plugin === "pi-check");
	if (plugin === "pi-check") {
		assert.equal(JSON.parse(readFileSync(join(agentDir, "pi-check/cli.json"), "utf8")).version, pkg.version);
		assert.match(execFileSync(process.execPath, [join(installed, "cli.mjs"), "--help"], { env, encoding: "utf8" }), /pi-check run/);
	} else if (plugin === "pi-flow") {
		for (const file of ["runner.mjs", "supervisor.mjs", "setup.mjs"]) assert.ok(files.includes(`package/${file}`));
	} else {
		assert.equal(pkg.dependencies.typebox, undefined);
		assert.equal(pkg.peerDependencies.typebox, "*");
		assert.deepEqual(result.tools.sort(), ["glitch_hunt", "glitch_lab_doctor", "ux_affordance_scan", "ux_journeys", "ux_report"]);
		for (const file of ["lib.mjs", "interactions.mjs", "glitch_lab.mjs", "affordance_scan.mjs", "journey_runner.mjs"]) assert.ok(files.includes(`package/scripts/${file}`));
	}
});

test("Pi detects unpinned Git updates without installing them and parses this release's notes", { timeout: 30000 }, (t) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "stack-pi-updates-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const remote = join(home, "remote"), agentDir = join(home, "agent");
	const installed = join(agentDir, "git/github.com/stacknyu/stack-pi-plugins");
	const source = "git:github.com/stacknyu/stack-pi-plugins";
	const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", GIT_CONFIG_NOSYSTEM: "1" };
	mkdirSync(remote);
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
	git(remote, "init", "-b", "main");
	git(remote, "config", "user.name", "Plugin Test");
	git(remote, "config", "user.email", "test@example.invalid");
	writeFileSync(join(remote, "README.md"), "initial\n");
	git(remote, "add", "."); git(remote, "commit", "-m", "initial");
	git(home, "clone", remote, installed);
	const original = git(installed, "rev-parse", "HEAD");
	const probe = (declared = source, action = "check") => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
		import { DefaultPackageManager, SettingsManager } from ${JSON.stringify(sdk)};
		const source = process.argv[1];
		const pm = new DefaultPackageManager({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory({ packages: [source] }) });
		if (process.argv[2] === "update") await pm.update(source);
		if (process.argv[2] === "offline") process.env.PI_OFFLINE = "1";
		console.log(JSON.stringify((await pm.checkForAvailableUpdates()).map(x => x.source)));
	`, declared, action], { cwd: home, env, encoding: "utf8", stdio: "pipe", timeout: 15000 }).trim().split("\n").at(-1));
	assert.deepEqual(probe(), []);
	writeFileSync(join(remote, "README.md"), "new commit without a version change\n");
	git(remote, "add", "."); git(remote, "commit", "-m", "update");
	assert.deepEqual(probe(), [source]);
	assert.equal(git(installed, "rev-parse", "HEAD"), original, "checking must not install the update");
	for (const declared of [`${source}@main`, `${source}@v0.1.0`, installed]) assert.deepEqual(probe(declared), []);
	assert.deepEqual(probe(source, "offline"), []);
	assert.deepEqual(probe(source, "update"), []);
	assert.equal(git(installed, "rev-parse", "HEAD"), git(remote, "rev-parse", "HEAD"));
	const notes = execFileSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { readFileSync } from "node:fs";
		import { parseChangelog, getNewEntries } from ${JSON.stringify(new URL("./utils/changelog.js", sdk).href)};
		const { version } = JSON.parse(readFileSync(${JSON.stringify(join(root, "package.json"))}, "utf8"));
		const entries = parseChangelog(${JSON.stringify(join(root, "CHANGELOG.md"))});
		assert.equal([entries[0].major, entries[0].minor, entries[0].patch].join("."), version);
		assert.equal(getNewEntries(entries, version).length, 0);
		console.log(getNewEntries(entries, "0.1.0").map(e => e.content).join("\\n"));
	`], { cwd: home, env, encoding: "utf8", timeout: 15000 });
	assert.match(notes, /pi-flow:/);
	assert.match(notes, /pi-check:/);
});

test("a clean Pi profile installs the bundle and loads both plugins and skills once", { timeout: 60000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "stack-pi-install-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	execFileSync(process.execPath, [cli, "install", root], { cwd: home, env, encoding: "utf8", timeout: 30000 });
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-mcp", "--no-context-files"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => { if (child.exitCode === null) child.kill(); });
	let stdout = "", stderr = "", commands;
	child.stderr.on("data", (data) => { stderr += data; });
	const exited = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.stdout.on("data", (data) => {
			stdout += data;
			let newline;
			while ((newline = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, newline);
				stdout = stdout.slice(newline + 1);
				try {
					const response = JSON.parse(line);
					if (response.id === "commands") {
						if (!response.success) throw new Error(JSON.stringify(response));
						commands = response.data.commands;
						child.stdin.end();
					}
				} catch (error) { child.kill(); reject(error); }
			}
		});
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Pi exited ${code}: ${stderr}`)));
	});
	child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
	await exited;
	assert.ok(commands, stderr);
	for (const name of ["task", "queue", "check", "skill:pi-flow", "skill:pi-check"]) {
		assert.equal(commands.filter((command) => command.name === name).length, 1, `${name}: ${stderr}`);
	}
	const registry = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-check", "cli.json"), "utf8"));
	assert.equal(registry.cli, join(root, "packages", "pi-check", "cli.mjs"));
	const found = execFileSync(process.execPath, ["--input-type=module", "-e", `import { checkBroker } from ${JSON.stringify(runner)}; console.log(JSON.stringify(checkBroker({})));`], { cwd: home, env, encoding: "utf8" });
	assert.equal(JSON.parse(found).cli, registry.cli);
});

test("project-local pi-check is available before a worktree worker starts, without duplicate global tools", { timeout: 60000 }, (t) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "stack-pi-worktree-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const repo = join(home, "repo"), agentDir = join(home, ".pi", "agent");
	mkdirSync(repo);
	const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const node = (code, args = []) => execFileSync(process.execPath, ["--input-type=module", "-e", code, ...args], { cwd: repo, env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Plugin Test");
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git("add", ".");
	git("commit", "-m", "fixture");
	execFileSync(process.execPath, [cli, "install", "-l", root], { cwd: repo, env, encoding: "utf8", timeout: 30000 });
	const settings = readFileSync(join(repo, ".pi", "settings.json"), "utf8");
	const probe = `
		import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(sdk)};
		const cwd = process.argv[1];
		const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.create(cwd, process.env.PI_CODING_AGENT_DIR, { projectTrusted: true }) });
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		console.log(JSON.stringify({ errors, tools: extensions.flatMap(e => [...e.tools.keys()]), commands: extensions.flatMap(e => [...e.commands.keys()]) }));`;
	assert.equal(JSON.parse(node(probe, [repo])).tools.filter((name) => name === "check").length, 1);
	const prepare = `
		import { DEFAULTS, ensureDir, prepareWorktree } from ${JSON.stringify(runner)};
		const repo = process.cwd();
		await ensureDir(repo);
		console.log(await prepareWorktree({ repo, c: { ...DEFAULTS, checkBroker: process.argv[1] !== "off" }, branch: "main", state: {}, save() {}, log() {} }, 0));`;
	const wt = node(prepare).trim();
	for (const global of [false, true]) {
		if (global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
		node(prepare); // reused slots must retain the bridge
		const result = JSON.parse(node(probe, [wt]));
		assert.deepEqual(result.errors, []);
		assert.equal(result.tools.filter((name) => name === "check").length, 1, "worktree must expose check exactly once");
		assert.equal(result.commands.filter((name) => name === "check").length, 1);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "pi-check", "cli.json"), "utf8")).cli, join(root, "packages", "pi-check", "cli.mjs"), "registry must not point into a disposable worktree");
		execFileSync("git", ["clean", "-fd"], { cwd: wt, env, encoding: "utf8" });
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wt, env, encoding: "utf8" }), "");
	}
	writeFileSync(join(agentDir, "settings.json"), "{}");
	node(prepare, ["off"]);
	assert.equal(JSON.parse(node(probe, [wt])).tools.includes("check"), false, "checkBroker:false must not inject the plugin");
	assert.equal(readFileSync(join(repo, ".pi", "settings.json"), "utf8"), settings, "main settings must remain unchanged");
	const bridge = join(wt, ".pi", "extensions", "pi-flow-check");
	writeFileSync(bridge, "user-owned file\n");
	assert.throws(() => node(prepare), /belongs to something else/);
	assert.equal(readFileSync(bridge, "utf8"), "user-owned file\n");
});
