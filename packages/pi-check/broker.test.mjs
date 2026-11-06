import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "./lib/broker.mjs";
import { loadConfig } from "./lib/repo.mjs";
import go from "./lib/adapters/go.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
function fixture(t, options = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-check-test-")));
	const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	writeFileSync(join(root, ".gitignore"), ".pi-check/\n");
	writeFileSync(join(root, "input.txt"), "one");
	const config = { watch: false, speculate: false, warmBase: false, nice: 0, maxJobs: 2, cpuBudget: 4, threads: 0, languages: { go: false, ts: false, python: false }, ...options };
	writeFileSync(join(root, "pi-check.json"), JSON.stringify(config));
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
	const b = new Broker(root);
	t.after(() => { for (const r of b.roots.values()) b.unwatch(r); rmSync(root, { recursive: true, force: true }); });
	return { root, b, config, git };
}

test("automatic CPU budget is independent of agents and honors explicit ceilings", (t) => {
	const { root, b } = fixture(t, { maxJobs: 0, cpuBudget: 8, fastLane: false });
	assert.equal(loadConfig(root).maxJobs, 8);
	b.groupOf = (task) => ({ name: task.uid, limit: 1 });
	b.pending = Array.from({ length: 4 }, (_, i) => ({ uid: String(i), priority: 10, seq: i }));
	b.startJob = (task, group, threads) => {
		b.pending.splice(b.pending.indexOf(task), 1);
		b.running.add({ group, threads });
	};
	b.pump();
	assert.deepEqual([...b.running].map((j) => j.threads), [2, 2, 2, 2]);
	b.pending.push({ uid: "extra" });
	assert.equal(b.allocation(b.pending[0]), 0);
	b.running.clear();
	assert.equal(b.allocation(b.pending[0]), 8);
	b.config.threads = 2;
	assert.equal(b.allocation(b.pending[0]), 2);
});

test("configuration reload waits for jobs to finish without changing their keys", (t) => {
	const { root, b, config } = fixture(t);
	const r = b.root(root), original = r.rc.config;
	b.running.add({});
	writeFileSync(join(root, "pi-check.json"), JSON.stringify({ ...config, threads: 1 }));
	assert.deepEqual(b.reload(), { deferred: true });
	assert.equal(r.rc.config, original);
	assert.equal(b.config.threads, 0);
	b.running.clear();
	b.pump();
	assert.equal(b.config.threads, 1);
	assert.equal(r.rc.config, b.config);
	assert.equal(b.pendingConfig, undefined);
});

test("identical requests across worktrees join once, then cache; changed input reruns", async (t) => {
	const { root, b, git } = fixture(t, { custom: [{ name: "sample", cmd: `${quote(process.execPath)} -e 'setTimeout(() => console.log("ok"), 80)'`, inputs: ["input.txt"] }] });
	const wt = `${root}-wt`;
	git("worktree", "add", "--detach", wt);
	t.after(() => rmSync(wt, { recursive: true, force: true }));
	const request = { scope: "all", kinds: ["custom"], strict: true };
	const [a, shared] = await Promise.all([b.run({ root, ...request }), b.run({ root: wt, ...request })]);
	assert.equal(a.ok, true);
	assert.equal(shared.shared, 1);
	assert.equal(b.stats.ran, 1);
	assert.equal((await b.run({ root: wt, ...request })).shared, 1);
	writeFileSync(join(wt, "input.txt"), "two");
	assert.equal((await b.run({ root: wt, ...request })).ran, 1);
	assert.equal(b.stats.ran, 2);
});

test("nested exec and Go shim run within one broker lease, not a second broker", async (t) => {
	const { root, b } = fixture(t, { maxJobs: 1, cpuBudget: 2 });
	const bin = join(root, "fake-bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "go"), '#!/bin/sh\nprintf "%s" "$PI_CHECK_BYPASS:$GOMAXPROCS:$GOFLAGS"\n', { mode: 0o755 });
	const inner = `${quote(process.execPath)} ${quote(cli)} shim go test`;
	const cmd = `PATH=${quote(bin)}:"$PATH" ${quote(process.execPath)} ${quote(cli)} exec -- ${quote(inner)}`;
	const result = await b.exec({ root, cwd: root, cmd });
	assert.equal(result.code, 0);
	assert.match(result.output, /1:2:.*-p=1/);
	assert.equal(existsSync(join(root, ".pi-check", "broker.json")), false);
	assert.equal(b.stats.execRuns, 1);
});

test("stale, missing and execution-error results cannot pass", (t) => {
	const { root, b } = fixture(t);
	const r = b.root(root), it = { project: { lang: "custom", dir: "." }, kind: "custom", unit: { label: "sample" } };
	for (const res of [undefined, { status: "pass", stale: true }, { status: "error", failures: [] }]) {
		assert.equal(b.report(r, {}, [{ it, res }], 0).ok, false);
	}
});

test("Go events expose progress and native flags reach the process", async (t) => {
	const { root, b } = fixture(t, { languages: { go: true, ts: false, python: false } });
	writeFileSync(join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
	writeFileSync(join(root, "demo_test.go"), "package demo\n");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "go"), `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==="vet") { if(!args.includes("-tags=fixture")) process.exit(2); } else { for(const e of [{Action:"run",Test:"TestDemo"},{Action:"output",Output:JSON.stringify(args)},{Action:"pass",Elapsed:0.001}]) console.log(JSON.stringify({Package:"example.test/demo",...e})); }\n`, { mode: 0o755 });
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	t.after(() => { process.env.PATH = previous; });
	const rc = b.root(root).rc;
	const project = go.detect(rc)[0], activity = [];
	const result = await go.run({ rc, project, kind: "test", units: go.units(rc, project, "test"), opts: {}, threads: 1, extraArgs: ["-timeout=2m"], onProgress: (event) => activity.push(event) });
	assert.equal(result.results.get(".").status, "pass");
	assert.match(result.results.get(".").output, /-count=1/);
	assert.match(result.results.get(".").output, /-timeout=2m/);
	assert.match(activity[0], /TestDemo: run/);
	const vet = await go.run({ rc, project, kind: "vet", units: go.units(rc, project, "vet"), opts: {}, threads: 1, extraArgs: ["-tags=fixture"] });
	assert.equal(vet.results.get(".").status, "pass");
});

test("late short checks start beside two long Go jobs within the shared budget", (t) => {
	const { b } = fixture(t, { maxJobs: 3, cpuBudget: 8 });
	const task = (id, lang, kind) => ({ project: { id, lang, dir: id }, kind, priority: 10, seq: Number(id.replace(/\D/g, "")) || 0 });
	b.startJob = (first, group, threads) => {
		b.pending.splice(b.pending.indexOf(first), 1);
		b.running.add({ tasks: [first], group, threads, lane: b.laneOf(first), speculativeOnly: () => false });
	};
	b.pending = [task("go1", "go", "test"), task("go2", "go", "test"), task("go3", "go", "test")];
	b.pump();
	assert.equal(b.running.size, 2);
	assert.equal([...b.running].reduce((n, j) => n + j.threads, 0), 7);
	b.pending.push(task("ts1", "ts", "typecheck"), task("ts2", "ts", "lint"));
	b.pump();
	assert.equal(b.running.size, 3);
	const fast = [...b.running].find((j) => j.lane === "fast");
	assert.equal(fast.tasks[0].project.id, "ts1");
	assert.equal(fast.threads, 1);
	assert.equal([...b.running].reduce((n, j) => n + j.threads, 0), 8);
	assert.deepEqual(b.pending.map((p) => p.project.id).sort(), ["go3", "ts2"]);
	b.running.delete(fast);
	b.pump();
	assert.equal([...b.running].find((j) => j.lane === "fast").tasks[0].project.id, "ts2");
	const heavy = [...b.running].find((j) => j.lane === "heavy");
	b.running.delete(heavy);
	b.pump();
	assert.equal(b.pending.length, 0); // fast traffic did not starve the next Go job
});

test("lane selection covers native, custom and raw commands without changing cache keys", (t) => {
	const { b, root } = fixture(t);
	assert.equal(b.laneOf({ project: { lang: "go", dir: "." }, kind: "test" }), "heavy");
	assert.equal(b.laneOf({ project: { lang: "go", dir: "." }, kind: "vet" }), "fast");
	assert.equal(b.laneOf({ project: { lang: "ts", dir: "." }, kind: "test" }), "fast");
	for (const cmd of ["pnpm@9.11.0 run type", "node --test tests/a.mjs", "tsc --noEmit"]) assert.equal(b.laneOf({ exec: { cmd } }), "fast");
	for (const cmd of ["pnpm build", "tsc --build", "go test ./... && pnpm type", "some unknown script"]) assert.equal(b.laneOf({ exec: { cmd } }), "heavy");
	assert.equal(b.laneOf({ project: { dir: ".", meta: { lane: "heavy", cmd: "node --test tests/a.mjs" } }, kind: "custom" }), "heavy");
	const rc = b.root(root).rc, project = { lang: "go", dir: "." }, unit = { target: ".", inputs: ["input.txt"] };
	const key = b.keyOf(rc, project, "test", unit);
	b.config.projects["."] = { test: { lane: "fast" } };
	assert.equal(b.laneOf({ project, kind: "test" }), "fast");
	assert.equal(b.keyOf(rc, project, "test", unit), key);
});

test("one-slot brokers stay serial and invalid lane configuration rejects", (t) => {
	const { b, root, config } = fixture(t, { maxJobs: 1, cpuBudget: 1 });
	assert.equal(b.laneReserved(), false);
	b.running.add({ threads: 1, group: { name: "heavy", limit: 1 }, lane: "heavy" });
	assert.equal(b.allocation({ kind: "typecheck" }), 0);
	writeFileSync(join(root, "pi-check.json"), JSON.stringify({ ...config, fastLane: "yes" }));
	assert.throws(() => loadConfig(root), /fastLane must be a boolean/);
	writeFileSync(join(root, "pi-check.json"), JSON.stringify({ ...config, custom: [{ lane: "turbo" }] }));
	assert.throws(() => loadConfig(root), /lane must be fast or heavy/);
});

test("heavy backlog cannot evict unrelated speculative work in the reserved lane", (t) => {
	const { b } = fixture(t);
	b.running.add({ threads: 1, lane: "fast", group: { name: "short", limit: 1 }, speculativeOnly: () => true });
	b.running.add({ threads: 3, lane: "heavy", group: { name: "long", limit: 1 }, speculativeOnly: () => false });
	b.pending.push({ project: { lang: "go", dir: "." }, kind: "test", priority: 10, seq: 1 });
	let aborted = 0;
	b.abortJob = () => { aborted++; };
	b.pump();
	assert.equal(aborted, 0);
});

test("a real short command completes while a heavy command is still running", async (t) => {
	const { root, b } = fixture(t, { custom: [
		{ name: "slow", lane: "heavy", cmd: `${quote(process.execPath)} -e 'const fs=require("fs");const timer=setInterval(()=>{if(fs.existsSync("release"))clearInterval(timer)},20)'`, inputs: ["input.txt"] },
		{ name: "quick", lane: "fast", cmd: `${quote(process.execPath)} -e 'process.exit(0)'`, inputs: ["input.txt"] },
	] });
	const slow = b.run({ root, scope: "all", projects: ["slow"], strict: true });
	try {
		assert.equal((await b.run({ root, scope: "all", projects: ["quick"], strict: true })).ok, true);
		assert.equal([...b.running].some((j) => j.lane === "heavy"), true);
	} finally { writeFileSync(join(root, "release"), "done"); await slow; }
});

test("Go work is package-sized and timeout changes the cache key", () => {
	assert.equal(go.batchSize("test"), 1);
	assert.equal(go.group({ dir: "." }, "test", {}).limit, Infinity);
	assert.equal(go.group({ dir: "." }, "test", { parallel: 1 }).limit, 1);
	assert.notEqual(go.argsKey({ timeout: "1m" }), go.argsKey({ timeout: "2m" }));
});
