import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

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
	const runner = new URL("../packages/pi-flow/runner.mjs", import.meta.url).href;
	const found = execFileSync(process.execPath, ["--input-type=module", "-e", `import { checkBroker } from ${JSON.stringify(runner)}; console.log(JSON.stringify(checkBroker({})));`], { cwd: home, env, encoding: "utf8" });
	assert.equal(JSON.parse(found).cli, registry.cli);
});
