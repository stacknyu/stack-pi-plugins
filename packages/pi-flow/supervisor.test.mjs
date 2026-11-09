import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
 text='CONTROL: '+JSON.stringify(prompt.includes("Health: failed")?{action:"retry",ids:["A01"],reason:"Previous provider exited; retry the original file change only"}:prompt.includes("Health: crashed")?{action:"restart",reason:"Clean crash left unrelated work pending"}:{action:"wait",reason:"No intervention needed"});
}else if(mode==="always-fail" || (["recover","stop"].includes(mode) && n===0)){stopReason="error";text="provider error";}
else if(mode==="blocked"){text="BLOCKED: missing credentials";}
else {const folder=mode==="worker-pause"&&n>0?"other":"out";fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,"a.txt"),"done\\n");if(mode==="worker-stop")fs.writeFileSync(path.join(repo,".pi-queue/STOP"),"");if(mode==="worker-pause"&&n===0)fs.writeFileSync(path.join(repo,".pi-queue/PAUSE"),"");}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason,content:[{type:"text",text}]}}));
`, { mode: 0o755 });
	git("add", "."); git("commit", "-m", "fixture");
	return { repo, c, git, state: () => loadJson(join(repo, ".pi-queue/state.json"), {}), count: (name) => Number(loadJson(join(repo, `.pi-queue/${name}-count`), 0)) };
}

// Real supervisor + real runner + fake provider. Markers coordinate independent workers
// with a deliberately slow manager, rather than simulating supervisor internals.
function liveFixture(t, mode = "live") {
	const f = fixture(t), { repo, c, git } = f;
	const concurrent = ["during-review", "backoff"].includes(mode);
	Object.assign(c, { parallel: concurrent ? 3 : 2, adaptive: false, allowedPaths: ["out", "other", "third"], ...(mode === "repair" ? { recovery: { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2 } } : {}) });
	writeFileSync(join(repo, c.queue), "- [ ] A01 — Write out/a.txt. Done when: created. [areas: out]\n- [ ] B01 — Write other/b.txt. Done when: created. [areas: other]\n" + (concurrent ? "- [ ] C01 — Write third/c.txt. Done when: created. [areas: third]\n" : ""));
	saveJson(join(repo, ".pi-queue/config.json"), c);
	saveJson(join(repo, ".tasks/sample/task.json"), { status: "queued", queuedAt: "2026-01-01", allowedPaths: c.allowedPaths, checks: c.checks, ...(c.recovery ? { recovery: c.recovery } : {}) });
	writeFileSync(c.piCommand, `#!/usr/bin/env node
const fs=require("fs"),path=require("path"),repo=${JSON.stringify(repo)},mode=${JSON.stringify(mode)};
const dir=path.join(repo,".pi-queue"),prompt=process.argv.at(-1),manager=process.argv.includes("--no-tools");
const file=n=>path.join(dir,n),read=n=>{try{return JSON.parse(fs.readFileSync(file(n),"utf8"))}catch{return {}}};
const mark=n=>fs.writeFileSync(file(n),"1"),has=n=>fs.existsSync(file(n));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw Error("fixture coordination timeout");await sleep(10)}}
(async()=>{
let text="DONE",stopReason="stop";
if(manager){
 if(!process.argv.includes("--no-extensions")||!process.argv.includes("--no-mcp"))throw Error("manager not isolated");
 const ids=[...prompt.matchAll(/^([AC]01) —/gm)].map(m=>m[1]);
 fs.appendFileSync(file("reviews.jsonl"),JSON.stringify({ids,at:Date.now(),running:read("state.json").running,repair:prompt.includes("Repair form:")})+"\\n");
 const n=Number(read("manager-count"))||0;fs.writeFileSync(file("manager-count"),String(n+1));
 mark("review-started");
 if(mode==="during-review"&&n===0)await until(()=>Object.keys(read("state.json").failed||{}).some(k=>k.startsWith("C01")));
 if(mode==="backoff"&&n===0){mark("review-failed");stopReason="error";text="provider unavailable";}
 else if(mode==="review-fail"){stopReason="error";text="unsupported provider";}
 else {
  if(mode==="stop"||mode==="pause")mark(mode.toUpperCase());
  if(mode==="config"){const c=read("config.json");c.maxNetLines++;fs.writeFileSync(file("config.json"),JSON.stringify(c));}
  if(mode==="stale"||mode==="quarantine"){
   // Test-only fault injection, after the original failure was presented to the model.
   const s=read("state.json"),key=Object.keys(s.failed).find(k=>k.startsWith("A01"));
   if(mode==="stale")s.failed[key]="BLOCKED: changed contract during review";
   else s.running[9]={id:"A01",key,quarantined:true};
   fs.writeFileSync(file("state.json"),JSON.stringify(s));
  }
  text="CONTROL: "+JSON.stringify({action:mode==="repair"?"repair":"retry",ids,...(mode==="repair"?{lines:["Fix the evidenced issue in out/repair.txt. Done when: focused validation passes. [areas: out]"]}:{}),reason:"Fix the evidenced provider failure inside each original area"});
 }
 mark("review-finished");
}else{
 const name=process.argv[process.argv.indexOf("-n")+1],id=name.match(/queue ([^:]+):/)[1];
 const n=Number(read(id+"-count"))||0;fs.writeFileSync(file(id+"-count"),String(n+1));
 if(id==="B01"){
  mark("B-started");
  if(["stop","pause","config","stale","quarantine","review-fail"].includes(mode))await until(()=>has("review-finished"));
  else await until(()=>has("A-recovered")&&(!["during-review","backoff"].includes(mode)||has("C-recovered")));
  if(["stale","quarantine"].includes(mode))await sleep(300);
 }else if(id.includes("-repair")){
  const m=read("manager.json");if(m.repairs!==1||m.attempts.A01!==1)throw Error("repair budget not reserved before worker launch");
  if(!prompt.includes("Manager diagnosis"))throw Error("repair worker did not receive failure evidence");
 }else if(n===0){
  await until(()=>has("B-started"));
  if(id==="C01")await until(()=>has(mode==="backoff"?"review-failed":"review-started"));
  stopReason="error";text="provider error for "+id;
 }else {
  if(mode==="repair"&&id==="A01"&&!fs.existsSync("out/A01-repair1.txt"))throw Error("repair prerequisite missing before parent replay");
  mark(id[0]+"-recovered");
 }
 if(stopReason==="stop"){
  const folder=id.includes("-repair")?"out":{A01:"out",B01:"other",C01:"third"}[id];fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,id+".txt"),"done\\n");
 }
}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason,content:[{type:"text",text}]}}));
})().catch(e=>{console.error(e);process.exitCode=1});
`, { mode: 0o755 });
	git("add", ".tasks"); git("commit", "-m", "live recovery fixture");
	return { ...f, reviews: () => {
		try { return readFileSync(join(repo, ".pi-queue/reviews.jsonl"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; }
	}, itemCount: (id) => Number(loadJson(join(repo, `.pi-queue/${id}-count`), 0)) };
}

test("approval and health reject open questions, changed scope, manual intent and orphaned workers", (t) => {
	const { repo, c } = fixture(t);
	assert.ok(approvedTask(repo, c));
	assert.equal(approvedTask(repo, { ...c, allowedPaths: ["."] }), undefined);
	writeFileSync(join(repo, ".tasks/sample/questions.md"), "- [ ] unanswered\n");
	assert.equal(approvedTask(repo, c), undefined);
	assert.equal(assessHealth({}, [], { running: true }), "healthy");
	assert.equal(assessHealth({}, [], { running: true, stopped: true }), "manual");
	assert.equal(assessHealth({ startedAt: 1, failed: { a: "check failed" }, running: { 0: { id: "B01" } } }, [{ key: "a" }], { running: true }), "failed");
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
	state.running = { 0: { id: "B01", key: "independent" } };
	assert.deepEqual(validateProposal(proposal, state, items, {}, "failed").ids, ["A01"]);
	for (const running of [{ 0: { id: "A01", quarantined: true } }, { 0: {} }]) {
		assert.throws(() => validateProposal(proposal, { ...state, running }, items, {}, "failed"));
	}
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
	assert.equal(count("manager"), 1);
	assert.equal(git("status", "--porcelain"), "");
	assert.equal(existsSync(join(repo, ".pi-queue/supervisor.pid")), false);
});

test("recovery is bounded and an identical exhausted incident is not prompted again", { timeout: 30000 }, async (t) => {
	const { repo, state, count } = fixture(t, "always-fail");
	await supervise(repo, { tickMs: 20, cooldownMs: 0 });
	assert.equal(count("worker"), 3);
	assert.equal(Object.keys(state().failed).length, 1);
	const turns = count("manager");
	assert.equal(turns, 2);
	await supervise(repo, { tickMs: 20, cooldownMs: 0 });
	assert.equal(count("worker"), 3);
	assert.equal(count("manager"), turns);
});

test("healthy work needs zero manager turns and manual stop prevents recovery", { timeout: 30000 }, async (t) => {
	for (const mode of ["pass", "stop", "blocked"]) {
		const { repo, count } = fixture(t, mode);
		await supervise(repo, { tickMs: 10, cooldownMs: 0 });
		assert.equal(count("worker"), 1);
		assert.equal(count("manager"), mode === "stop" ? 1 : 0);
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

test("explicit start resumes a previously started and drained PAUSE without a manager turn", { timeout: 30000 }, async (t) => {
	const { repo, c, git, state, count } = fixture(t, "worker-pause");
	c.allowedPaths.push("other");
	writeFileSync(join(repo, c.queue), readFileSync(join(repo, c.queue), "utf8") + "- [ ] B01 — Write other/a.txt. Done when: created. [areas: other]\n");
	saveJson(join(repo, ".pi-queue/config.json"), c);
	const taskFile = join(repo, ".tasks/sample/task.json");
	saveJson(taskFile, { ...loadJson(taskFile, {}), allowedPaths: c.allowedPaths });
	git("add", ".tasks"); git("commit", "-m", "pause resume fixture");
	await supervise(repo, { tickMs: 20 });
	assert.ok(state().startedAt);
	assert.equal(Object.keys(state().done).length, 1);
	assert.equal(existsSync(join(repo, ".pi-queue/PAUSE")), true);
	assert.equal(await startRunner(repo, true), "");
	const deadline = Date.now() + 15000;
	while (Object.keys(state().done).length < 2 || existsSync(join(repo, ".pi-queue/supervisor.pid"))) {
		assert.ok(Date.now() < deadline, "resumed runner did not drain");
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(count("worker"), 2);
	assert.equal(count("manager"), 0);
});

test("a manual retry inbox resumes a terminal run without spending automatic budget", { timeout: 30000 }, async (t) => {
	const { repo, state, count } = fixture(t);
	await main(repo);
	assert.ok(state().startedAt);
	assert.equal(Object.keys(state().failed).length, 1);
	enqueueControl(repo, { task: "sample", by: "user", action: "retry", ids: ["A01"] });
	await supervise(repo, { tickMs: 20 });
	assert.equal(Object.keys(state().done).length, 1);
	assert.equal(count("worker"), 2);
	assert.equal(count("manager"), 0);
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

test("IPC wakes live recovery while an independent worker remains active", { timeout: 30000 }, async (t) => {
	const { repo, state, reviews, itemCount } = liveFixture(t);
	// The watchdog cannot rescue this test: item/control/exit IPC must wake supervision.
	await supervise(repo, { tickMs: HEALTH_TICK_MS });
	assert.equal(Object.keys(state().done).length, 2);
	assert.equal(itemCount("A01"), 2);
	assert.equal(reviews().length, 1);
	assert.equal(reviews()[0].repair, false);
	assert.ok(Object.values(reviews()[0].running).some((r) => r.id === "B01"));
	assert.equal(loadJson(join(repo, ".pi-queue/manager.json"), {}).attempts.A01, 1);
});

test("approved targeted repair reserves budgets before dispatch while independent work runs", { timeout: 30000 }, async (t) => {
	const { repo, c, git, state, reviews, itemCount } = liveFixture(t, "repair");
	const approval = approvedTask(repo, c);
	await supervise(repo, { tickMs: 20 });
	assert.equal(Object.keys(state().done).length, 3);
	assert.equal(itemCount("A01-repair1"), 1);
	assert.equal(itemCount("A01"), 2);
	assert.equal(reviews().length, 1);
	assert.equal(reviews()[0].repair, true);
	const manager = loadJson(join(repo, ".pi-queue/manager.json"), {});
	assert.equal(manager.repairs, 1);
	assert.equal(manager.attempts.A01, 1);
	assert.equal(approvedTask(repo, c), approval);
	assert.deepEqual(git("ls-files", "out", "other").trim().split("\n").sort(), ["other/B01.txt", "out/A01-repair1.txt", "out/A01.txt"]);
	assert.match(manager.reply, /Fix the evidenced provider failure/);
	assert.deepEqual(state().failed, {});
});

test("an unrelated failure arriving during review neither cancels recovery nor gets dropped", { timeout: 30000 }, async (t) => {
	const { repo, state, reviews, itemCount } = liveFixture(t, "during-review");
	await supervise(repo, { tickMs: 20 });
	assert.equal(Object.keys(state().done).length, 3);
	assert.deepEqual(reviews().map((r) => r.ids), [["A01"], ["C01"]]);
	assert.equal(itemCount("A01"), 2);
	assert.equal(itemCount("C01"), 2);
});

test("new failures bypass failed-review backoff; the failed incident remains retryable", { timeout: 30000 }, async (t) => {
	const { repo, state, reviews } = liveFixture(t, "backoff");
	await supervise(repo, { tickMs: 20, reviewBackoffMs: 3000 });
	assert.equal(Object.keys(state().done).length, 3);
	assert.deepEqual(reviews().map((r) => r.ids), [["A01"], ["C01"], ["A01"]]);
	assert.ok(reviews()[2].at - reviews()[0].at >= 3000);
});

test("unsupported manager providers get bounded persistent review attempts", { timeout: 30000 }, async (t) => {
	const { repo, reviews, itemCount } = liveFixture(t, "review-fail");
	await supervise(repo, { tickMs: 20, reviewBackoffMs: 100 });
	assert.equal(reviews().length, 2);
	assert.ok(reviews()[1].at - reviews()[0].at >= 100);
	assert.equal(itemCount("A01"), 1);
	await supervise(repo, { tickMs: 20, reviewBackoffMs: 100 });
	assert.equal(reviews().length, 2);
});

test("a busy persisted manager defers intervention instead of terminating supervision", { timeout: 30000 }, async (t) => {
	const { repo, c, state, count } = fixture(t);
	await main(repo); // first provider attempt fails
	const busy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" });
	t.after(() => { try { busy.kill(); } catch {} });
	saveJson(join(repo, ".pi-queue/manager.json"), { task: c.task, approval: approvedTask(repo, c), attempts: {}, pid: busy.pid });
	await supervise(repo, { tickMs: 20 });
	assert.equal(Object.keys(state().done).length, 1);
	assert.equal(count("manager"), 1);
});

test("stop, pause and changed config during review remain authoritative", { timeout: 60000 }, async (t) => {
	for (const mode of ["stop", "pause", "config"]) {
		const { repo, reviews, itemCount } = liveFixture(t, mode);
		await supervise(repo, { tickMs: 20 });
		assert.equal(reviews().length, 1, mode);
		assert.equal(itemCount("A01"), 1, mode);
		assert.deepEqual(loadJson(join(repo, ".pi-queue/manager.json"), {}).attempts, {}, mode);
		assert.equal(existsSync(join(repo, ".pi-queue/supervisor.pid")), false, mode);
	}
});

test("selected stale failures and newly quarantined targets reject async proposals", { timeout: 60000 }, async (t) => {
	for (const mode of ["stale", "quarantine"]) {
		const { repo, itemCount } = liveFixture(t, mode);
		await supervise(repo, { tickMs: 20, reviewBackoffMs: 100 });
		assert.equal(itemCount("A01"), 1, mode);
		assert.deepEqual(loadJson(join(repo, ".pi-queue/manager.json"), {}).attempts, {}, mode);
	}
});

test("approval pins recovery authority and all run safety configuration", (t) => {
	const { repo, c } = fixture(t), original = approvedTask(repo, c);
	for (const change of [{ maxNetLines: 999 }, { itemChecks: { A01: [] } }, { setup: "unsafe" }, { parallel: 8 }, { stopAfterFailuresInARow: 99 }]) {
		assert.notEqual(approvedTask(repo, { ...c, ...change }), original);
	}
	const recovery = { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2 };
	assert.equal(approvedTask(repo, { ...c, recovery }), undefined);
	const taskFile = join(repo, ".tasks/sample/task.json");
	saveJson(taskFile, { ...loadJson(taskFile, {}), recovery });
	assert.equal(approvedTask(repo, c), undefined);
	assert.ok(approvedTask(repo, { ...c, recovery }));
});

test("restart limits are approved and exhausted persistent budgets cause no model turn or launch", { timeout: 10000 }, async (t) => {
	const { repo, c, count } = fixture(t), proposal = { action: "restart", reason: "clean runner crash" };
	assert.throws(() => validateProposal(proposal, {}, [], {}, "crashed", { recovery: { maxRestarts: 0 } }));
	assert.equal(validateProposal(proposal, {}, [], { restarts: 2 }, "crashed", { recovery: { maxRestarts: 3 } }).action, "restart");
	assert.throws(() => validateProposal(proposal, { running: { 0: { id: "A01" } } }, [], {}, "crashed", c));
	saveJson(join(repo, ".pi-queue/state.json"), { startedAt: 1, phase: "running items", runId: "crashed", running: {} });
	saveJson(join(repo, ".pi-queue/manager.json"), { task: c.task, approval: approvedTask(repo, c), attempts: {}, restarts: 2 });
	await supervise(repo, { tickMs: 20 });
	assert.equal(count("worker"), 0);
	assert.equal(count("manager"), 0);
});

test("explicit start overrides exhausted automatic restarts once but never orphan ownership", { timeout: 30000 }, async (t) => {
	for (const quarantined of [false, true]) {
		const { repo, c, state, count } = fixture(t, "pass");
		const running = quarantined ? { 0: { id: "A01", quarantined: true } } : {};
		saveJson(join(repo, ".pi-queue/state.json"), { startedAt: 1, phase: "running items", runId: "crashed", running, done: {}, failed: {} });
		const budget = { attempts: { A01: 2 }, restarts: 2, repairs: 4 };
		saveJson(join(repo, ".pi-queue/manager.json"), { task: c.task, approval: approvedTask(repo, c), ...budget });
		const result = await startRunner(repo, true);
		if (quarantined) assert.match(result, /interrupted workers remain/);
		else assert.equal(result, "");
		const deadline = Date.now() + 15000;
		while (existsSync(join(repo, ".pi-queue/supervisor.pid")) || (!quarantined && !Object.keys(state().done).length)) {
			assert.ok(Date.now() < deadline, "explicit start did not drain");
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.equal(count("worker"), quarantined ? 0 : 1);
		assert.equal(count("manager"), 0);
		assert.deepEqual(state().running, running);
		const manager = loadJson(join(repo, ".pi-queue/manager.json"), {});
		assert.deepEqual(manager.attempts, budget.attempts);
		assert.equal(manager.restarts, budget.restarts);
		assert.equal(manager.repairs, budget.repairs);
	}
});

test("queued automatic retry and repair lose authority when questions, rules or config change", { timeout: 60000 }, async (t) => {
	for (const action of ["retry", "repair"]) for (const changed of ["questions", "rules", "config"]) {
		const { repo, c, git, state, count } = fixture(t);
		c.recovery = { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2 };
		saveJson(join(repo, ".pi-queue/config.json"), c);
		const taskFile = join(repo, ".tasks/sample/task.json");
		saveJson(taskFile, { ...loadJson(taskFile, {}), recovery: c.recovery });
		git("add", ".tasks"); git("commit", "-m", "approve recovery fixture");
		await main(repo);
		const before = state(), items = allItems(readFileSync(join(repo, c.queue), "utf8"), before);
		const proposal = validateProposal({ action, ids: ["A01"], reason: "Fix the original failed item", lines: ["Fix the evidenced defect. Done when: checks pass. [areas: out]"] }, before, items, {}, "failed", c);
		const approval = approvedTask(repo, c);
		assert.ok(approval);
		enqueueControl(repo, { task: c.task, by: "auto", approval, ...proposal, failures: { A01: before.failed[items[0].key] } });
		if (changed === "config") saveJson(join(repo, ".pi-queue/config.json"), { ...c, maxNetLines: c.maxNetLines + 1 });
		else {
			writeFileSync(join(repo, `.tasks/sample/${changed}.md`), changed === "questions" ? "- [ ] New unresolved question\n" : "Changed approved rules\n");
			// Keep the tree clean so this exercises inbox consumption, not dirty-tree refusal.
			git("add", ".tasks"); git("commit", "-m", "revoke queued recovery approval");
		}
		await main(repo);
		assert.equal(count("worker"), 1, `${action}/${changed}`);
		assert.equal(count("manager"), 0);
		assert.deepEqual(state().failed, before.failed);
		assert.deepEqual(state().done, {});
		assert.deepEqual(state().fixes ?? {}, {});
		assert.equal(state().controlReceipts.length, 1, "revoked control was consumed without applying");
	}
});

test("historical exhausted failures do not suppress a clean restart of unrelated open work", { timeout: 30000 }, async (t) => {
	const { repo, c, git, state, count } = fixture(t, "pass");
	writeFileSync(join(repo, c.queue), readFileSync(join(repo, c.queue), "utf8") + "- [ ] B01 — Write another file. Done when: created. [areas: out]\n");
	git("add", ".tasks"); git("commit", "-m", "historical failure fixture");
	const items = allItems(readFileSync(join(repo, c.queue), "utf8"), {});
	const snapshot = { startedAt: 1, phase: "running items", runId: "crashed", running: {}, done: {}, failed: { [items[0].key]: "old provider failure" } };
	assert.equal(assessHealth(snapshot, items, { running: false }), "crashed");
	saveJson(join(repo, ".pi-queue/state.json"), snapshot);
	saveJson(join(repo, ".pi-queue/manager.json"), { task: c.task, approval: approvedTask(repo, c), attempts: { A01: 2 }, restarts: 0 });
	await supervise(repo, { tickMs: 20 });
	assert.ok(state().done[items[1].key]);
	assert.equal(state().failed[items[0].key], "old provider failure");
	assert.equal(count("worker"), 1);
	assert.equal(count("manager"), 1);
	assert.equal(loadJson(join(repo, ".pi-queue/manager.json"), {}).restarts, 1);
});

test("Web manager is chat-only and session identity is persisted before prompting", { timeout: 15000 }, async (t) => {
	let created, recorded = false, prompted = false;
	const web = {
		create: async (body) => { created = body; return { sessionId: "web-manager" }; },
		send: async (_id, body) => {
			if (body.type === "prompt") { assert.ok(recorded); prompted = true; }
			return { data: null };
		},
		history: async () => ({ context: { entryIds: prompted ? ["answer"] : [], messages: prompted ? [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: 'CONTROL: {"action":"wait","reason":"healthy"}' }] }] : [] } }),
		running: async () => ({ runningSessionIds: [] }),
	};
	const result = await webTurn({ c: DEFAULTS, web, manager: true, stopRequested: () => false, onWorker: () => { recorded = true; } }, fixture(t).repo, {}, "manager", "review", 1);
	assert.deepEqual(created.toolNames, []);
	assert.equal(created.type, "ensure_session");
	assert.equal(result.status, "ok");
});

test("planning cleanup honors Web refusal/errors and remains retryable; CLI cleanup stays local", async (t) => {
	const { repo } = fixture(t), id = "planning", file = join(repo, "planning.jsonl");
	const taskFile = join(repo, ".tasks/sample/task.json"), statusFile = join(repo, ".pi-flow/status.json");
	saveJson(taskFile, { ...loadJson(taskFile, {}), slug: "sample", planningSessions: [id] });
	mkdirSync(join(repo, ".pi-flow"));
	saveJson(statusFile, { sample: { planningFiles: { [id]: file } } });
	writeFileSync(file, "preserve this session\n");
	let response = "running", attempts = 0;
	t.mock.method(globalThis, "fetch", async (url) => {
		if (response === "offline") throw new Error("offline");
		const path = new URL(url).pathname;
		if (path === "/api/agent/running") return Response.json({ runningSessionIds: [] });
		assert.equal(path, "/api/sessions/delete");
		attempts++;
		if (response === "error") return Response.json({ error: "unavailable" }, { status: 500 });
		if (response === "deleted") { rmSync(file); return Response.json({ deleted: [id] }); }
		return Response.json({ running: [id], deleted: [] });
	});
	for (response of ["running", "error"]) {
		assert.match(await cleanup(repo, false, "current"), /deletion was not confirmed/);
		assert.equal(readFileSync(file, "utf8"), "preserve this session\n");
		assert.equal(loadJson(statusFile, {}).sample.cleanedAt, undefined);
	}
	response = "deleted";
	await cleanup(repo, false, "current");
	assert.equal(attempts, 3);
	assert.ok(loadJson(statusFile, {}).sample.cleanedAt);
	response = "offline";
	saveJson(statusFile, { sample: { planningFiles: { [id]: file } } });
	writeFileSync(file, "CLI session\n");
	await cleanup(repo, false, "current");
	assert.equal(existsSync(file), false);
});
