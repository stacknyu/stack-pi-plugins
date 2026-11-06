import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedTask, assessHealth, supervise, validateProposal, HEALTH_TICK_MS } from "./supervisor.mjs";
import { acquireProcessLock, allItems, DEFAULTS, enqueueControl, loadJson, main, pathAllowed, saveJson, webTurn } from "./runner.mjs";
import { control, cleanup, startRunner } from "./extension.ts";

function fixture(t, mode = "recover") {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-flow-supervisor-"))), repo = join(home, "repo");
	mkdirSync(repo);
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	mkdirSync(join(repo, ".tasks", "sample"), { recursive: true });
	mkdirSync(join(repo, ".pi-queue"));
	writeFileSync(join(repo, ".gitignore"), ".pi-queue/\n");
	const c = { ...DEFAULTS, task: "sample", queue: ".tasks/sample/items.md", checks: ["git diff --check"], checkBroker: false, allowedPaths: ["out"], model: "example/small", thinking: "off", runIn: "cli", parallel: 1, setup: "", autoSplit: false, deferBlocked: false, fixRounds: 0, deleteSessions: false, piCommand: join(home, "fake-pi") };
	for (const f of ["brief.md", "rules.md", "questions.md"]) writeFileSync(join(repo, ".tasks/sample", f), "Approved fixture\n");
	writeFileSync(join(repo, c.queue), "- [ ] A01 — Write out/a.txt. Done when: created. [areas: out]\n");
	saveJson(join(repo, ".tasks/sample/task.json"), { status: "queued", queuedAt: "2026-01-01", allowedPaths: c.allowedPaths, checks: c.checks });
	saveJson(join(repo, ".pi-queue/config.json"), c);
	writeFileSync(c.piCommand, `#!/usr/bin/env node
const fs=require("fs"),path=require("path"),repo=${JSON.stringify(repo)}, mode=${JSON.stringify(mode)};
const prompt=process.argv.at(-1), manager=process.argv.includes("--no-tools");
const count=path.join(repo,".pi-queue",manager?"manager-count":"worker-count");
const n=fs.existsSync(count)?Number(fs.readFileSync(count)):0; fs.writeFileSync(count,String(n+1));
let text="DONE",stopReason="stop";
if(manager){
 if(!process.argv.includes("--no-extensions"))process.exit(5);
 if(mode==="stop")fs.writeFileSync(path.join(repo,".pi-queue/STOP"),"");
 text='CONTROL: '+JSON.stringify(prompt.includes("Health: failed")?{action:"retry",ids:["A01"],reason:"Previous provider exited; retry the original file change only"}:{action:"wait",reason:"No intervention needed"});
}else if(mode==="always-fail" || (mode==="recover" && n===0)){stopReason="error";text="provider error";}
else if(mode==="blocked"){text="BLOCKED: missing credentials";}
else {fs.mkdirSync("out",{recursive:true});fs.writeFileSync("out/a.txt","done\\n");if(mode==="worker-stop")fs.writeFileSync(path.join(repo,".pi-queue/STOP"),"");}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason,content:[{type:"text",text}]}}));
`, { mode: 0o755 });
	git("add", "."); git("commit", "-m", "fixture");
	return { repo, c, git, state: () => loadJson(join(repo, ".pi-queue/state.json"), {}), count: (name) => Number(loadJson(join(repo, `.pi-queue/${name}-count`), 0)) };
}

test("approval and health reject open questions, changed scope, manual intent and orphaned workers", (t) => {
	const { repo, c } = fixture(t);
	assert.ok(approvedTask(repo, c));
	assert.equal(approvedTask(repo, { ...c, allowedPaths: ["."] }), undefined);
	writeFileSync(join(repo, ".tasks/sample/questions.md"), "- [ ] unanswered\n");
	assert.equal(approvedTask(repo, c), undefined);
	assert.equal(assessHealth({}, [], { running: true }), "healthy");
	assert.equal(assessHealth({}, [], { running: true, stopped: true }), "manual");
	assert.equal(assessHealth({ running: { 0: { pid: 1 } } }, [], { running: false }), "blocked");
	assert.equal(HEALTH_TICK_MS, 60000);
	assert.equal(pathAllowed("../secret", ["."]), false);
});

test("automatic proposals cannot add work, use prefixes, bypass blockers or exceed persisted budgets", (t) => {
	const { repo, c } = fixture(t), items = allItems(readFileSync(join(repo, c.queue), "utf8"), {});
	const state = { failed: { [items[0].key]: "check failed" } };
	const proposal = { action: "retry", ids: ["A01"], reason: "Fix the failing assertion within original scope" };
	assert.deepEqual(validateProposal(proposal, state, items, {}, "failed").ids, ["A01"]);
	for (const change of [{ action: "add" }, { ids: ["A"] }, { reason: "" }]) assert.throws(() => validateProposal({ ...proposal, ...change }, state, items, {}, "failed"));
	assert.throws(() => validateProposal(proposal, state, items, { attempts: { A01: 2 } }, "failed"));
	state.failed[items[0].key] = "BLOCKED: missing credentials";
	assert.throws(() => validateProposal(proposal, state, items, {}, "failed"));
});

test("exclusive process ownership and interrupted work prevent restart/cleanup", async (t) => {
	const { repo, state } = fixture(t);
	const file = join(repo, ".pi-queue/runner.pid"), release = acquireProcessLock(file);
	assert.throws(() => acquireProcessLock(file), /owns/);
	release(); release();
	saveJson(join(repo, ".pi-queue/state.json"), { running: { 0: { id: "A01", quarantined: true } } });
	await main(repo);
	assert.equal(state().running[0].quarantined, true);
	assert.match(await cleanup(repo, true, "current"), /interrupted/);
	assert.equal(existsSync(join(repo, ".pi-queue/worktrees/w0")), false);
});

test("CLI supervisor creates one manager, repairs an item and preserves failure evidence", { timeout: 30000 }, async (t) => {
	const { repo, state, count, git } = fixture(t);
	await supervise(repo, { tickMs: 20, cooldownMs: 0 });
	assert.equal(Object.keys(state().done).length, 1);
	assert.equal(count("worker"), 2);
	assert.equal(loadJson(join(repo, ".pi-queue/manager.json"), {}).attempts.A01, 1);
	assert.ok(count("manager") <= 2);
	assert.equal(git("status", "--porcelain"), "");
	assert.equal(existsSync(join(repo, ".pi-queue/supervisor.pid")), false);
});

test("recovery is bounded and an identical exhausted incident is not prompted again", { timeout: 30000 }, async (t) => {
	const { repo, state, count } = fixture(t, "always-fail");
	await supervise(repo, { tickMs: 20, cooldownMs: 0 });
	assert.equal(count("worker"), 3);
	assert.equal(Object.keys(state().failed).length, 1);
	const turns = count("manager");
	await supervise(repo, { tickMs: 20, cooldownMs: 0 });
	assert.equal(count("worker"), 3);
	assert.equal(count("manager"), turns);
});

test("healthy work gets only its initial manager turn and manual stop prevents recovery", { timeout: 30000 }, async (t) => {
	for (const mode of ["pass", "stop", "blocked"]) {
		const { repo, count } = fixture(t, mode);
		await supervise(repo, { tickMs: 10, cooldownMs: 0 });
		assert.equal(count("worker"), 1);
		assert.ok(count("manager") <= (mode === "blocked" ? 2 : 1));
		if (mode === "stop") assert.equal(existsSync(join(repo, ".pi-queue/STOP")), true);
	}
});

test("controls use the same durable inbox and explicit start resumes a paused queue", { timeout: 30000 }, async (t) => {
	const { repo, c, state } = fixture(t, "pass");
	c.manager = false; saveJson(join(repo, ".pi-queue/config.json"), c);
	await control(repo, { action: "pause" });
	await main(repo);
	assert.equal(Object.keys(state().done ?? {}).length, 0);
	await Promise.all([control(repo, { action: "parallel", value: 1 }), control(repo, { action: "next", ids: ["A01"] })]);
	assert.equal(await startRunner(repo, true), "");
	while (existsSync(join(repo, ".pi-queue/supervisor.pid"))) await new Promise((r) => setTimeout(r, 20));
	assert.equal(Object.keys(state().done).length, 1);
	assert.equal(existsSync(join(repo, ".pi-queue/PAUSE")), false);
	assert.match(readFileSync(join(repo, ".pi-queue/log.md"), "utf8"), /CONTROL next/);
	// A stale automatic request cannot clear a different failure.
	const key = Object.keys(state().done)[0];
	const next = state(); delete next.done[key]; next.failed[key] = "new failure";
	saveJson(join(repo, ".pi-queue/state.json"), next);
	enqueueControl(repo, { task: "sample", by: "auto", action: "retry", ids: ["A01"], failures: { A01: "old failure" } });
	await main(repo);
	assert.equal(state().failed[key], "new failure");
});

test("quarantined slots exit instead of spinning with independent work left", { timeout: 10000 }, async (t) => {
	const { repo, c, state, git } = fixture(t, "pass");
	writeFileSync(join(repo, c.queue), readFileSync(join(repo, c.queue), "utf8") + "- [ ] B01 — Other work. Done when: done. [areas: other]\n");
	const taskFile = join(repo, ".tasks/sample/task.json");
	saveJson(taskFile, { ...loadJson(taskFile, {}), itemChecks: { B01: [] } });
	git("add", ".tasks"); git("commit", "-m", "quarantine fixture");
	await main(repo);
	assert.equal(state().running[0].quarantined, true);
	assert.match(state().phase, /quarantined/);
	assert.equal(Object.keys(state().failed).length, 1);
});

test("manual worker stop preserves work without counting a real failure", { timeout: 10000 }, async (t) => {
	const { repo, state, git } = fixture(t, "worker-stop");
	await main(repo);
	assert.equal(state().failureStreak, 0);
	assert.equal(Object.keys(state().failed).length, 0);
	assert.match(git("branch", "--list", "queue-failed/*"), /queue-failed\/A01/);
	assert.equal(Object.keys(state().running).length, 0);
});

test("Web manager is chat-only and session identity is persisted before prompting", { timeout: 15000 }, async (t) => {
	let created, recorded = false;
	const web = {
		create: async (body) => { created = body; return { sessionId: "web-manager" }; },
		send: async (_id, body) => {
			if (body.type === "prompt") assert.ok(recorded);
			return { data: { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: 'CONTROL: {"action":"wait","reason":"healthy"}' }] }] } };
		},
		running: async () => ({ runningSessionIds: [] }),
	};
	const result = await webTurn({ c: DEFAULTS, web, manager: true, stopRequested: () => false, onWorker: () => { recorded = true; } }, fixture(t).repo, {}, "manager", "review", 1);
	assert.deepEqual(created.toolNames, []);
	assert.equal(created.type, "ensure_session");
	assert.equal(result.status, "ok");
});
