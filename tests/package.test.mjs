import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const cli = fileURLToPath(new URL("./cli.js", sdk));
const runner = new URL("../packages/pi-flow/runner.mjs", import.meta.url).href;

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
