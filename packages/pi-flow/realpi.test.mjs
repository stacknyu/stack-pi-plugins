// The runner against the REAL pi CLI (the version installed in this repo), with a local fake model server.
// Skips when pi is not installed. Covers what fake-pi fixtures cannot: the RPC protocol, session switching across
// worktrees, tool calls landing in the right worktree, and no pi process left behind.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, allItems, loadJson, main, pidAlive, saveJson } from "./runner.mjs";

const PI = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin/pi");

/** OpenAI-compatible streaming chat completions; answers by what the conversation asks. */
function fakeModel(decide) {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const j = JSON.parse(body || "{}");
			const text = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join(""));
			const firstUser = text(j.messages.find((m) => m.role === "user"));
			const answer = decide({ firstUser, last: j.messages.at(-1), lastText: text(j.messages.at(-1)) });
			const base = { id: "x", object: "chat.completion.chunk", created: 1, model: j.model };
			const delta = answer.tool
				? { role: "assistant", tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] }
				: { role: "assistant", content: answer.text };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.tool ? "tool_calls" : "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("real pi: items run in parallel RPC processes, write into their own worktrees, a failed item is reworked, nothing is left running", { timeout: 120000, skip: !existsSync(PI) && "pi is not installed" }, async (t) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-flow-realpi-"))), repo = join(home, "repo"), agent = join(home, "agent");
	t.after(() => rmSync(home, { recursive: true, force: true }));
	let reworked = false;
	const server = await fakeModel(({ firstUser, last, lastText }) => {
		if (last.role === "tool") return { text: "DONE\nthe file — written" };
		if (/Your job: find out from the code WHY/.test(firstUser)) reworked = true;
		if (/Your job: find out from the code WHY/.test(firstUser)) return { text: "REWRITE: Write out/A01.txt (there is no out/conf). Done when: out/A01.txt exists. [areas: out/A01.txt]" };
		const item = firstUser.match(/ITEM: (\w+) — (.*)/);
		if (!item || last.role !== "user" || lastText !== firstUser) return { text: "DONE" };
		if (item[1] === "A01" && !reworked) return { text: "BLOCKED: out/conf/settings.txt does not exist" };
		return { tool: "write", args: { path: `out/${item[1]}.txt`, content: `${item[1]} from ${item[2].slice(0, 20)}\n` } };
	});
	t.after(() => server.close());
	mkdirSync(agent);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m1" }] } } }));
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.PI_OFFLINE = "1";
	t.after(() => { process.env.PI_CODING_AGENT_DIR = saved.dir; process.env.PI_OFFLINE = saved.offline; if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; if (saved.offline === undefined) delete process.env.PI_OFFLINE; });

	mkdirSync(join(repo, ".tasks/sample"), { recursive: true });
	mkdirSync(join(repo, ".pi-queue"));
	mkdirSync(join(repo, "out"));
	writeFileSync(join(repo, "out/.keep"), "");
	writeFileSync(join(repo, ".gitignore"), ".pi-queue/\n");
	const lines = ["A01 — Put the setting in out/conf/settings.txt. Done when: the setting exists. [areas: out]", "B01 — Write out/B01.txt. Done when: it exists. [areas: out/B01.txt]", "C01 — Write out/C01.txt. Done when: it exists. [areas: out/C01.txt]"];
	writeFileSync(join(repo, ".tasks/sample/items.md"), lines.map((l) => `- [ ] ${l}`).join("\n") + "\n");
	// count pi starts through a wrapper
	const wrapper = join(home, "pi-wrapper.sh");
	writeFileSync(wrapper, `#!/bin/sh\necho start >> ${JSON.stringify(join(home, "starts"))}\nexec ${JSON.stringify(PI)} "$@"\n`, { mode: 0o755 });
	saveJson(join(repo, ".pi-queue/config.json"), { ...DEFAULTS, queue: ".tasks/sample/items.md", task: "sample", allowedPaths: ["out"], checks: ["git diff --check"], checkBroker: false, piCommand: wrapper, runIn: "cli", model: "fake/m1", thinking: "off", parallel: 2, setup: "", deleteSessions: false, outageMinutes: 0 });
	const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	git("init", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid"); git("add", "."); git("commit", "-m", "fixture");

	await main(repo);
	const state = loadJson(join(repo, ".pi-queue/state.json"), {});
	const log = readFileSync(join(repo, ".pi-queue/log.md"), "utf8");
	assert.ok(state.done, log);
	const items = allItems(readFileSync(join(repo, ".tasks/sample/items.md"), "utf8"), state);
	for (const i of items) assert.ok(state.done[i.key], `${i.id}: ${state.failed[i.key]}\n${log}`);
	for (const id of ["A01", "B01", "C01"]) assert.match(git("show", `main:out/${id}.txt`), new RegExp(`^${id} from`));
	assert.match(state.rewrites?.[items[0].key] ?? "", /^A01 — Write out\/A01\.txt/, log);
	assert.match(log, /REWORK A01 · agent: BLOCKED: out\/conf\/settings\.txt does not exist → rewritten/);
	// every session was a real pi session in the queue's session folder, each with its own worktree as cwd
	const sessions = Object.keys(state.sessions);
	assert.ok(sessions.length >= 4, JSON.stringify(state.sessions));
	assert.equal(readFileSync(join(home, "starts"), "utf8").trim().split("\n").length, 2, "parallel 2: two pi processes for 3 items, 5 sessions and 2 worktrees");
	const pids = [...new Set(Object.values(state.running ?? {}).map((r) => r.rpcPid))];
	assert.equal(Object.keys(state.running).length, 0);
	// no pi process from this run is still alive (they all ran from the repo folder)
	const left = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(PI) || (l.includes("pi-coding-agent") && l.includes(join(repo, ".pi-queue", "sessions"))));
	assert.deepEqual(left, [], "pi processes left running");
	assert.ok(pids.every((p) => !p || !pidAlive(p)));
	// the extension dialogs and session names reached pi: every session file carries its item name
	const names = execFileSync("grep", ["-rhoE", '"name":"(queue|rework) [A-Z0-9]+', join(repo, ".pi-queue/sessions")], { encoding: "utf8" }).trim().split("\n");
	assert.ok(names.some((n) => n.includes("rework A01")) && names.some((n) => n.includes("queue B01")), names.join(", "));
});
