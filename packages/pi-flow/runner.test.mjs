import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, boosted, straysIn, killStrays, parseQueue, itemConfig, piTurn, webTurn, applyControl, checksText, checkLine, dependencyGraph, orderQueue, areasOverlap, webClient, deleteSessions, main, loadJson, saveJson, notifyRunner, allItems, validateRecovery, pidAlive, widenable, mentionedPaths, reworkable, planGapJobs, admissionProblem, reopenDependents, runReport, checkOwners } from "./runner.mjs";

const item = (tags = "") => parseQueue(`- [ ] A01 — Edit one file. Done when: tested. [areas: src/a] ${tags}`)[0];
const model = { provider: "example", id: "small", reasoning: false, cost: { input: 1, output: 2 } };
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-flow-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("item session tags override defaults without mutating them", () => {
	const defaults = { ...DEFAULTS, model: "example/large", thinking: "high" };
	const selected = itemConfig(defaults, item("[model: example/small] [thinking: off] [files=7 lines=200 min=20]"));
	assert.equal(selected.model, "example/small");
	assert.equal(selected.thinking, "off");
	assert.equal(selected.maxNetLines, 200);
	assert.equal(defaults.thinking, "high");
	assert.equal(itemConfig(defaults, item()).model, "example/large");
	assert.doesNotMatch(item("[model: example/small] [thinking: off]").title, /model|thinking/);
	assert.throws(() => itemConfig(defaults, item("[thinking: turbo]")), /invalid/);
	assert.throws(() => itemConfig(defaults, item("[model: small]")), /invalid/);
	assert.throws(() => itemConfig(defaults, item("[thinking: low] [thinking: high]")), /duplicate/);
});

test("focused item checks select the exact owner, inherit to children, and fail closed", () => {
	const c = { ...DEFAULTS, checks: ["git diff --check"], itemChecks: { A01: ["cd apps/api && go test ./roles -run '^TestSelectedBranch$'"] } };
	// generated items (split parts, gap fixes, repairs, their parts) use the planned item's checks
	for (const id of ["A01", "A01a", "A01-fix1", "A01a-fix2", "A01-repair1", "A01-fix1b"]) {
		const selected = itemConfig(c, { ...item(), id });
		assert.deepEqual(selected.checks, [...c.checks, ...c.itemChecks.A01], id);
		assert.deepEqual(c.checks, ["git diff --check"]);
	}
	for (const id of ["B01", "B01-fix1"]) assert.throws(() => itemConfig(c, { ...item(), id }), /focused itemChecks/);
	assert.throws(() => itemConfig({ ...c, itemChecks: { A01: [""] } }, item()), /invalid/);
});

test("focused item checks deduplicate exact commands in order without mutating configuration", () => {
	const global = Object.freeze(["git diff --check", "pnpm run lint", "git diff --check"]);
	const focused = Object.freeze(["pnpm run lint", "pnpm run test", "pnpm run test", "pnpm run test -- --coverage"]);
	const c = Object.freeze({ ...DEFAULTS, checks: global, itemChecks: Object.freeze({ A01: focused }) });
	const expected = ["git diff --check", "pnpm run lint", "pnpm run test", "pnpm run test -- --coverage"];
	for (const id of ["A01", "A01a"]) {
		const parent = { ...item(), id };
		const selected = itemConfig(c, parent);
		assert.deepEqual(selected.checks, expected);
		assert.deepEqual(itemConfig(selected, parent).checks, expected);
		assert.deepEqual(itemConfig(c, { ...item(), id: "A01-repair1", repairParent: parent }).checks, expected);
	}
	assert.deepEqual(global, ["git diff --check", "pnpm run lint", "git diff --check"]);
	assert.deepEqual(focused, ["pnpm run lint", "pnpm run test", "pnpm run test", "pnpm run test -- --coverage"]);
});

test("focused worker instructions use the runner's broker commands in the worktree", () => {
	const c = itemConfig({ ...DEFAULTS, checks: ["git diff --check"], itemChecks: { A01: ["node --test tests/one.test.mjs"] } }, item());
	const text = checksText(c);
	for (const command of c.checks) assert.ok(text.includes(checkLine(c, command, ".").line));
	assert.match(text, /only these exact selections/);
	assert.match(text, /same selections after rebase/);
	assert.match(text, /no tool-specific RESULT: PASS text is required/);
	assert.doesNotMatch(text, /--cwd '\/Users\//);
	assert.equal(itemConfig(DEFAULTS, item()).checks, DEFAULTS.checks);
});

test("planner gets actual model capabilities, cost and upfront selection instructions", async (t) => {
	const { planPrompt } = await import("./extension.ts");
	const prompt = planPrompt(fixture(t), "sample", "edit a file", [model]);
	assert.match(prompt, /example\/small: thinking=off; input=1, output=2/);
	assert.match(prompt, /Choose a \[tier: light\|standard\|heavy\] for each item during planning/);
	assert.match(prompt, /Never make a trivial edit/);
	assert.match(prompt, /"limits": \{"maxNetLines"/);
	assert.match(prompt, /rules.md/);
	assert.match(prompt, /The user.s setting is the ceiling/);
	assert.match(prompt, /\[readonly\] items: they take no area locks/);
	assert.match(prompt, /Agree recovery authority upfront/);
	assert.match(prompt, /set individual budgets to 0 to prohibit them/);
});

test("planner requests bounded, optional fresh-context review before handoff", async (t) => {
	const { planPrompt } = await import("./extension.ts");
	const prompt = planPrompt(fixture(t), "sample", "change the billing contract");
	const start = prompt.indexOf("## 4. Optional fresh-context plan review"), end = prompt.indexOf("## 5. Hand off");
	assert.ok(start > prompt.indexOf("## 3. Ask") && end > start);
	const review = prompt.slice(start, end);
	for (const instruction of [
		"Skip routine localized changes", "honor an explicit request to skip review", "one fresh read-only reviewer",
		"not this conversation", "first paraphrase", "at most three consequential", "paths and concrete rationale",
		'If unavailable or the reviewer fails, record "not run"', "Never present a same-conversation self-review as independent",
		"not a handoff gate", "put proceeding without it in questions.md and ask; never bypass that requirement", "do not claim instruction-file or filesystem isolation", "not to edit files, run checks, commit, control the queue or spawn more agents",
		"contest with evidence", "Put new user decisions in questions.md and ask before handoff", "do not silently accept a safety trade-off",
		".tasks/sample/rules.md", "not a separate report hierarchy", "Do not start repeat review rounds unless the user asks", "Zero findings is acceptable, not proof of correctness",
	]) assert.ok(review.includes(instruction), instruction);
});

test("handoff rejects unavailable models and unsupported effort before checks/commit", async (t) => {
	const { handoff } = await import("./extension.ts");
	const root = fixture(t), dir = join(root, ".tasks", "sample");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "task.json"), JSON.stringify({ allowedPaths: ["src/"], checks: ["must-not-run"], model: "example/small", thinking: "off" }));
	for (const f of ["brief.md", "rules.md", "questions.md"]) writeFileSync(join(dir, f), "");
	const ctx = { modelRegistry: { getAvailable: () => [model] } };
	for (const [tags, error] of [["[model: example/missing]", /not available/], ["[thinking: high]", /not supported/]]) {
		writeFileSync(join(dir, "items.md"), `- [ ] ${item(tags).line}`);
		const result = await handoff(root, "sample", ctx);
		assert.equal(result.ok, false);
		assert.match(result.text, error);
		assert.doesNotMatch(result.text, /checks fail/);
	}
	writeFileSync(join(dir, "items.md"), `- [ ] ${item().line}`);
	for (const invalid of [{ maxAttempts: 6 }, { maxRepairs: -1 }, { maxRestarts: 1.5 }, { unexpected: 1 }]) {
		const recovery = { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2, ...invalid };
		writeFileSync(join(dir, "task.json"), JSON.stringify({ allowedPaths: ["src/"], checks: ["must-not-run"], model: "example/small", thinking: "off", recovery }));
		const result = await handoff(root, "sample", ctx);
		assert.equal(result.ok, false);
		assert.match(result.text, /recovery/i);
		assert.doesNotMatch(result.text, /checks fail/);
	}
});

test("CLI worker receives resolved model and thinking flags", async (t) => {
	const root = fixture(t), fake = join(root, "fake-pi");
	writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));\n', { mode: 0o755 });
	const c = itemConfig(DEFAULTS, item("[model: example/small] [thinking: off]"));
	const result = await piTurn({ repo: root, c, pi: fake, env: process.env, stopRequested: () => false }, root, "test-id", "test", "hello", 1);
	assert.equal(result.status, "ok");
	const args = JSON.parse(result.reply);
	assert.equal(args[args.indexOf("--model") + 1], "example/small");
	assert.equal(args[args.indexOf("--thinking") + 1], "off");
	assert.equal(args.includes("-a"), false, "worker must not override a saved trust denial");
});

test("Pi Web worker receives the same resolved pair", async (t) => {
	let created, prompted = false;
	const c = itemConfig(DEFAULTS, item("[model: example/small] [thinking: off]"));
	const web = {
		create: async (body) => { created = body; return { sessionId: "fake" }; },
		send: async (_id, body) => { if (body.type === "prompt") prompted = true; return { data: null }; },
		history: async () => ({ context: { entryIds: prompted ? ["answer"] : [], messages: prompted ? [{ role: "assistant", content: [{ type: "text", text: "DONE" }], stopReason: "stop" }] : [] } }),
		running: async () => ({ runningSessionIds: [] }),
	};
	const result = await webTurn({ c, web, stopRequested: () => false }, fixture(t), {}, "test", "hello", 1);
	assert.equal(result.status, "ok");
	assert.equal(created.type, "ensure_session", "record the worker identity before sending its prompt");
	assert.equal(created.provider, "example");
	assert.equal(created.modelId, "small");
	assert.equal(created.thinkingLevel, "off");
});

test("Pi Web HTTP contract reads fresh results and waits for subagents, including after abort", async (t) => {
	const schedule = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (fn) => schedule(fn, 0));
	for (const scenario of ["stop", "error", "toolUse", "stale", "compacted", "descendants", "grandchildren", "abort-descendants", "abort-grandchildren"]) {
		let prompted = false, polls = 0, aborted = false, pages = 0, catalogReads = 0;
		t.mock.method(globalThis, "fetch", async (url, options) => {
			const path = new URL(url).pathname;
			assert.match(options.headers.authorization, /^Basic /);
			if (path === "/api/agent/new") return Response.json({ success: true, sessionId: "worker/1" });
			if (path === "/api/agent/worker%2F1") {
				const body = JSON.parse(options.body);
				assert.ok(["prompt", "abort", "set_session_name", "get_state"].includes(body.type), body.type);
				if (body.type === "prompt") prompted = true;
				if (body.type === "abort") aborted = true;
				return Response.json({ success: true, data: {} });
			}
			if (path === "/api/agent/running") {
				polls++;
				const busy = scenario.startsWith("abort-") || (["descendants", "grandchildren"].includes(scenario) && polls <= 2);
				return Response.json({ runningSessionIds: [], subagentsActiveSessionIds: busy ? [scenario.includes("grandchildren") ? "child" : "worker/1"] : [] });
			}
			if (path === "/api/sessions") {
				catalogReads++;
				return Response.json({ sessions: [{ id: "grandchild", relation: { kind: "subagent", parentSessionId: "child" } }, { id: "child", relation: { kind: "subagent", parentSessionId: "worker/1" } }] });
			}
			if (path.endsWith("/context")) {
				assert.equal(scenario, "compacted");
				assert.equal(new URL(url).searchParams.get("before"), "compaction /1");
				pages++;
			} else {
				assert.equal(path, "/api/sessions/worker%2F1");
				if (scenario === "compacted") return Response.json({ context: { entryIds: ["compaction /1"], messages: [{ role: "custom", customType: "compaction" }], oldestEntryId: "compaction /1", hasMore: true } });
			}
			const fresh = prompted && scenario !== "stale";
			return Response.json({ context: { entryIds: [fresh ? "new" : "old"], messages: [{ role: "assistant", content: [{ type: "text", text: "DONE" }], stopReason: ["error", "toolUse"].includes(scenario) ? scenario : "stop", ...(scenario === "error" ? { errorMessage: "provider failed" } : {}) }] } });
		});
		const c = { ...DEFAULTS, piWebUrl: "http://example.invalid", piWebPassword: "test-only" };
		const result = await webTurn({ c, web: webClient(c), stopRequested: () => false }, fixture(t), {}, "test", "hello", scenario.startsWith("abort-") ? -1 : 1);
		assert.equal(result.status, ["stop", "compacted", "descendants", "grandchildren"].includes(scenario) ? "ok" : "error", scenario);
		if (scenario === "stale") assert.match(result.err, /no new assistant/);
		if (scenario === "error") assert.equal(result.err, "provider failed");
		if (scenario === "toolUse") assert.match(result.err, /toolUse/);
		if (scenario === "compacted") assert.equal(pages, 2);
		if (["descendants", "grandchildren"].includes(scenario)) assert.equal(polls, 4);
		if (scenario === "grandchildren") assert.equal(catalogReads, 2);
		if (scenario.startsWith("abort-")) { assert.equal(aborted, true); assert.equal(result.quiescent, false); }
		globalThis.fetch.mock.restore(); // stacked mocks on one method do not unwind to the real fetch at test end
	}
});

test("queue widgets belong to their own native/RPC extension instance", async (t) => {
	const { default: extension } = await import("./extension.ts");
	const timers = new Set();
	t.mock.method(globalThis, "setInterval", (tick) => { const timer = { tick, unref() {} }; timers.add(timer); return timer; });
	t.mock.method(globalThis, "clearInterval", (timer) => timers.delete(timer));
	const instances = ["tui", "rpc", "json"].map((mode) => {
		const commands = new Map(), events = new Map(), widgets = [];
		extension({ registerTool() {}, registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => events.set(name, handler) });
		return { commands, events, widgets, ctx: { mode, hasUI: mode !== "json", cwd: fixture(t), ui: { notify() {}, setWidget: (_key, lines) => widgets.push(lines) } } };
	});
	for (const instance of instances) await instance.commands.get("queue").handler("watch", instance.ctx);
	assert.equal(timers.size, 2);
	await instances[0].events.get("session_shutdown")({}, instances[0].ctx);
	assert.equal(timers.size, 1);
	for (const timer of timers) timer.tick();
	assert.equal(instances[1].widgets.length, 2);
	assert.equal(instances[0].widgets.at(-1), undefined);
	await instances[1].commands.get("queue").handler("watch off", instances[1].ctx);
	assert.equal(timers.size, 0);
});

test("queue open switches native sessions and explains unsupported Web navigation", async (t) => {
	const { default: extension } = await import("./extension.ts");
	const cwd = fixture(t), sessions = join(cwd, ".pi-queue", "sessions"), commands = new Map();
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "native.jsonl"), "fixture\n");
	writeFileSync(join(cwd, ".pi-queue", "state.json"), JSON.stringify({ sessions: { native: { item: "A01", status: "done" } } }));
	extension({ registerTool() {}, on() {}, registerCommand: (name, command) => commands.set(name, command) });
	for (const mode of ["tui", "rpc"]) {
		const notices = [];
		await commands.get("queue").handler("open A01", { cwd, mode, hasUI: true,
			switchSession: async (file) => { assert.equal(file, join(sessions, "native.jsonl")); return { cancelled: mode === "rpc" }; },
			ui: { setWidget() {}, notify: (text) => notices.push(text) } });
		assert.equal(notices.length, mode === "rpc" ? 1 : 0);
		if (mode === "rpc") assert.match(notices[0], /pi --session/);
	}
});

test("Web cleanup batches at 500 IDs and retains refused or failed sessions", async () => {
	for (const mode of ["delete", "archive"]) {
		const ids = Array.from({ length: 501 }, (_, i) => `session-${i}`), batches = [];
		const state = { sessions: Object.fromEntries(ids.map((id) => [id, { web: true }])) };
		const accept = async (batch) => { batches.push(batch); if (batches.length === 2) throw new Error("unavailable"); return { deleted: batch.slice(1), running: batch.slice(0, 1) }; };
		const count = await deleteSessions({ state, web: { del: accept, ui: ({ ids }) => accept(ids) }, save() {}, log() {} }, ids, mode);
		assert.deepEqual(batches.map((b) => b.length), [500, 1]);
		assert.equal(count, mode === "archive" ? 500 : 499);
		assert.equal(state.sessions[ids[0]].deleted, undefined);
		assert.equal(state.sessions[ids[500]][mode === "archive" ? "archived" : "deleted"], undefined);
	}
});

test("dependency validation rejects cycles and unknown ids, including wildcard cycles", () => {
	for (const text of [
		"- [ ] A01 [after: A01]",
		"- [ ] A01 [after: B01]\n- [ ] B01 [after: A01]",
		"- [ ] A01 [after: V01]\n- [ ] V01 [after: *]",
	]) assert.throws(() => dependencyGraph(parseQueue(text)), /cycle/);
	assert.throws(() => dependencyGraph(parseQueue("- [ ] A01 [after: missing]")), /unknown/);
	assert.doesNotThrow(() => dependencyGraph(parseQueue("- [ ] A01\n- [ ] V01 [after: *]\n- [ ] V02 [after: *]")));
	assert.throws(() => parseQueue("- [ ] A01 [after: B01] [after: C01]"), /duplicate/);
	assert.throws(() => parseQueue("- [ ] A01 [areas: src/a] [area: src/b]"), /duplicate/);
});

test("critical-path prerequisites run first and explicit next preserves requested order", () => {
	const items = parseQueue("- [ ] A01 leaf\n- [ ] B01 foundation\n- [ ] C01 middle [after: B01]\n- [ ] D01 end [after: C01]");
	const state = { done: {}, failed: {}, retried: {} };
	assert.deepEqual(orderQueue(items, state).map((i) => i.id), ["B01", "C01", "A01", "D01"]);
	applyControl(state, items, { action: "next", ids: ["D01", "A01"] });
	assert.deepEqual(orderQueue(items, state).slice(0, 2).map((i) => i.id), ["D01", "A01"]);
	const split = [{ ...items[0], id: "P01a", child: true }, { ...items[1], id: "P01b", child: true }, { ...items[2], after: ["P01"] }];
	assert.deepEqual(dependencyGraph(split).get("C01"), ["P01a", "P01b"]);
});

test("area conflicts handle repository root, boundaries and partial globs conservatively", () => {
	assert.equal(areasOverlap(["."], ["src/a"]), true);
	assert.equal(areasOverlap(["src/a"], ["src/ab"]), false);
	assert.equal(areasOverlap(["src/foo*"], ["src/foobar/a"]), true);
	assert.equal(areasOverlap(["src/a/../b"], ["src/b/x"]), true);
	assert.equal(areasOverlap(["src/a"], ["src/a/file.ts"]), true);
});

test("unpark honors selected ids", () => {
	const items = parseQueue("- [ ] A01 — first\n- [ ] B01 — second");
	const state = { done: {}, failed: {}, retried: Object.fromEntries(items.map((i) => [i.key, true])) };
	assert.deepEqual(applyControl(state, items, { action: "unpark", ids: ["A01"] }), ["A01"]);
	assert.equal(state.retried[items[1].key], true);
});

test("CLI errors do not pass and a completed provider retry clears an earlier error", async (t) => {
	const root = fixture(t), fake = join(root, "fake-pi");
	for (const recovery of [false, true]) {
		writeFileSync(fake, `#!/usr/bin/env node\nconst emit=(stopReason)=>console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"DONE"}],stopReason}}));emit("error");${recovery ? 'emit("stop");' : ""}\n`, { mode: 0o755 });
		const result = await piTurn({ repo: root, c: DEFAULTS, pi: fake, env: process.env, stopRequested: () => false, manager: true }, root, "test", "manager", "hello", 1);
		assert.equal(result.status, recovery ? "ok" : "error");
	}
});

test("automatic repairs inherit the parent contract and reopen dependent work only after repair completion", () => {
	const queue = "- [ ] A01 — Build feature. Done when: works. [areas: src/a] [model: example/small] [thinking: off] [files=2 lines=30 min=10]\n- [ ] B01 — Use feature. Done when: works. [areas: src/b] [after: A01]";
	const items = allItems(queue, {}), parent = items[0];
	const state = { done: {}, failed: { [parent.key]: "checks failed", [items[1].key]: "depends on A01, which failed" } };
	const c = { ...DEFAULTS, allowedPaths: ["src"], checks: ["baseline"], itemChecks: { A01: ["focused"] }, recovery: { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2 } };
	const proposal = { action: "repair", ids: ["A01"], reason: "Fix the reported parser assertion", lines: ["Fix parser. Done when: focused assertion passes. [areas: src/a/parser.ts]"] };
	const action = validateRecovery(proposal, state, items, {}, c);
	applyControl(state, items, action);
	const [repair, original, dependent] = allItems(queue, state);
	assert.equal(repair.id, "A01-repair1");
	assert.deepEqual(original.after, [repair.id]);
	assert.deepEqual(dependent.after, ["A01"]);
	assert.deepEqual(state.failed, {});
	const selected = itemConfig(c, repair);
	assert.deepEqual(selected.checks, ["baseline", "focused"]);
	assert.deepEqual(selected.allowedPaths, ["src/a/parser.ts"]);
	assert.equal(selected.model, "example/small");
	assert.equal(selected.thinking, "off");
	assert.equal(selected.maxNetLines, 30);
	assert.equal(selected.maxFilesGrowing, 2);
	assert.equal(selected.itemMinutes, 10);
	assert.doesNotThrow(() => dependencyGraph([repair, original, dependent]));
	state.failed[repair.key] = "checks failed";
	assert.throws(() => validateRecovery({ ...proposal, ids: [repair.id] }, state, [repair, original, dependent], {}, c), /authority/);
});

test("automatic recovery rejects unapproved repairs, scope escape, overrides, ownership and exhausted budgets", () => {
	const items = [item()], parent = items[0];
	const state = { failed: { [parent.key]: "check failed" } };
	const c = { ...DEFAULTS, allowedPaths: ["src"], recovery: { maxAttempts: 2, maxRepairs: 4, maxRestarts: 2 } };
	const proposal = { action: "repair", ids: [parent.id], reason: "Repair assertion", lines: ["Fix parser. Done when: assertion passes. [areas: src/a/parser.ts]"] };
	assert.throws(() => validateRecovery(proposal, state, items, {}, { ...c, recovery: undefined }), /authority/);
	assert.throws(() => validateRecovery(proposal, state, items, { repairs: 4 }, c), /budget/);
	assert.throws(() => validateRecovery(proposal, { failed: { [parent.key]: "depends on A01-repair1, which failed" } }, items, {}, c), /prerequisite/);
	assert.throws(() => validateRecovery(proposal, state, items, { attempts: { A01: 2 } }, c), /budget/);
	for (const line of [
		"Fix unrelated. Done when: passes. [areas: src/b]",
		"Escape. Done when: passes. [areas: src/a/../../private]",
		"Widen. Done when: passes. [areas: src/a/*]",
		"Change model. Done when: passes. [areas: src/a] [model: example/large]",
		"Change budget. Done when: passes. [areas: src/a] [big]",
		"Cycle. Done when: passes. [areas: src/a] [after: A01]",
		"No acceptance. [areas: src/a]",
		"Two lines. Done when: passes. [areas: src/a]\n- [ ] B01 injected",
	]) assert.throws(() => validateRecovery({ ...proposal, lines: [line] }, state, items, {}, c), line);
	assert.throws(() => validateRecovery(proposal, state, items, {}, { ...c, allowedPaths: ["other"] }), /scope/);
	for (const running of [{ 0: { id: "A01" } }, { 0: { key: parent.key, quarantined: true } }, { 0: {} }]) assert.throws(() => validateRecovery(proposal, { ...state, running }, items, {}, c), /owns/);
	assert.doesNotThrow(() => validateRecovery(proposal, { ...state, running: { 0: { id: "B01" } } }, items, {}, c));
	for (const failure of ["BLOCKED: missing credentials", "outside allowed scope", "agent: BLOCKED: decision: which tier", "agent: BLOCKED: env: no staging key", "permission denied"]) assert.throws(() => validateRecovery(proposal, { failed: { [parent.key]: failure } }, items, {}, c), /human attention/);
});

test("retry reopens transitive scheduler dependency failures without clearing independent real failures", () => {
	const items = parseQueue("- [ ] A01 root\n- [ ] B01 child [after: A01]\n- [ ] C01 leaf [after: B01]\n- [ ] D01 independent");
	const state = { done: {}, failed: Object.fromEntries(items.map((i, n) => [i.key, ["check failed", "depends on A01, which failed", "depends on B01, which failed", "check failed"][n]])) };
	applyControl(state, items, { action: "retry", ids: ["A01"], by: "auto" });
	assert.deepEqual(state.failed, { [items[3].key]: "check failed" });
});

// Exercise the real scheduler, worktrees, commits, checks and integration. Barriers live outside
// the repository so they cannot affect scope or cleanliness. No model or broker is required.
function schedulerFixture(t, specs, config = {}, seed = {}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-flow-schedule-"))), repo = join(home, "repo");
	mkdirSync(repo);
	const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	mkdirSync(join(repo, ".pi-queue"));
	mkdirSync(join(repo, ".tasks", "sample"), { recursive: true });
	mkdirSync(join(repo, "out"));
	writeFileSync(join(repo, "out", "shared.txt"), "initial\n");
	writeFileSync(join(repo, ".gitignore"), ".pi-queue/\n");
	const items = parseQueue(specs.map((s) => `- [ ] ${s.id} — ${s.id}. Done when: verified. [areas: ${s.area || `out/${s.id}.txt`}] ${s.check ? "[check]" : ""} ${s.readonly ? "[readonly]" : ""} ${s.after ? `[after: ${s.after}]` : ""} ${s.tags ?? ""}`).join("\n"));
	writeFileSync(join(repo, ".tasks/sample/items.md"), items.map((i) => `- [ ] ${i.line}`).join("\n"));
	const common = `const fs=require('fs'),path=require('path'),home=${JSON.stringify(home)},specs=${JSON.stringify(specs)};
const file=(name)=>path.join(home,name), read=(name)=>fs.existsSync(file(name))?fs.readFileSync(file(name),'utf8'):'';
const count=(key)=>{const n=Number(read(key)||0)+1;fs.writeFileSync(file(key),String(n));return n;};
const event=(kind,id,n,phase)=>fs.appendFileSync(file('events'),JSON.stringify({kind,id,n,phase})+'\\n');
async function barrier(key,hold){const until=Date.now()+20000;while(hold&&!fs.existsSync(file(key))&&!fs.existsSync(file('release-all'))){if(Date.now()>until)throw Error('barrier timed out: '+key);await new Promise(r=>setTimeout(r,10));}}
`;
	const worker = join(home, "worker.cjs"), check = join(home, "check.cjs");
	writeFileSync(worker, `#!/usr/bin/env node\n${common}
let aborted=false;
async function turn(id,text){const s=specs.find(s=>s.id===id)||{id},n=count('worker-'+id),phase=s.check&&n===1?'verification':'coding';
fs.writeFileSync(file(path.basename(process.cwd())+'.owner'),id);fs.writeFileSync(file('prompt-'+id+'-'+n),text);event('start',id,n,phase);
if(s.requires&&!fs.existsSync(s.requires))throw Error('dependency not integrated: '+s.requires);
if(n>1&&s.requiresAfterFirst&&!fs.existsSync(s.requiresAfterFirst))throw Error('deferred work retried before integration');
if(!s.check&&/Before you stop, run:|Run the checks, then reply DONE/.test(text))throw Error('mandatory verification leaked into coding prompt');
const until=Date.now()+20000,key='worker-'+id+'-'+n,hold=s.holdWorker===true||(s.holdWorker||[]).includes(n);
while(hold&&!fs.existsSync(file(key))&&!fs.existsSync(file('release-all'))){if(aborted)throw Object.assign(Error('aborted'),{aborted:true});if(Date.now()>until)throw Error('barrier timed out: '+key);await new Promise(r=>setTimeout(r,10));}
const reply=(s.replies||[])[n-1]||'DONE';
if(!s.check&&!s.noChange&&!/BLOCKED|ERROR|WAITING|ALREADY DONE|NEEDS/.test(reply)){fs.mkdirSync('out',{recursive:true});fs.writeFileSync(s.path||'out/'+id+'.txt',id+' turn '+n+'\\n');for(const [p,k] of Object.entries(s.write||{})){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Array.from({length:k},(_,j)=>'line '+j).join('\\n')+'\\n');}}
event('end',id,n,phase);return reply;}
const say=(reply)=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:reply==='ERROR'?'error':'stop',content:[{type:'text',text:reply}]}}));
const idOf=(name)=>(name.match(/^(?:queue|rework) (\\S+):/)||[])[1];
if(process.argv.includes('rpc')){
// RPC mode: one long-lived process; sessions switch, names come from set_session_name
fs.appendFileSync(file('rpc-starts'),process.pid+'\\n');
let name='',file0='',buf='';const out=(r)=>process.stdout.write(JSON.stringify(r)+'\\n');
const head=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8').split('\\n')[0])}catch{return {}}};
const handle=async(cmd)=>{const ok=(data)=>out({id:cmd.id,type:'response',command:cmd.type,success:true,data});
if(cmd.type==='get_state')return ok({sessionId:head(file0).id,sessionFile:file0});
// like real pi: a session's tools run in the folder its header names
if(cmd.type==='switch_session'){file0=cmd.sessionPath;const h=head(file0);if(h.cwd)process.chdir(h.cwd);name=h.name||'';return ok({cancelled:false});}
if(cmd.type==='set_session_name'){name=cmd.name;fs.writeFileSync(file0,JSON.stringify({...head(file0),name})+'\\n');return ok({});}
if(cmd.type==='abort'){aborted=true;return ok({});}
if(cmd.type!=='prompt')return ok({});
ok({disposition:'started'});aborted=false;
if(/^rework /.test(name)){fs.appendFileSync(file('reworks'),idOf(name)+'\\n');const s=specs.find(s=>s.id===idOf(name))||{};const k=count('rework-'+idOf(name));say((s.rework||[])[k-1]||'GIVE UP: no idea');return out({type:'agent_settled',aborted:false});}
try{say(await turn(idOf(name),cmd.message));out({type:'agent_settled',aborted:false});}
catch(e){out({type:'message_end',message:{role:'assistant',stopReason:e.aborted?'aborted':'error',errorMessage:String(e.message),content:[]}});out({type:'agent_settled',aborted:!!e.aborted});}};
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(line.trim())handle(JSON.parse(line));}});
process.stdin.on('end',()=>process.exit(0));
}else{
(async()=>{const name=process.argv[process.argv.indexOf('-n')+1];
if(/^rework /.test(name)){const s=specs.find(s=>s.id===idOf(name))||{};fs.appendFileSync(file('reworks'),idOf(name)+'\\n');const k=count('rework-'+idOf(name));return say((s.rework||[])[k-1]||'GIVE UP: no idea');}
say(await turn(idOf(name),process.argv.at(-1)));
})().catch(e=>{console.error(e);process.exitCode=1});}\n`, { mode: 0o755 });
	writeFileSync(check, `${common}
(async()=>{const id=read(path.basename(process.cwd())+'.owner');if(!id)return;
const s=specs.find(s=>s.id===id)||{id},n=count('check-'+id);event('start',id,n,'check');
await barrier('check-'+id+'-'+n,s.holdCheck===true||(s.holdCheck||[]).includes(n));
event('end',id,n,'check');if((s.failChecks||[]).includes(n))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});\n`);
	const c = { ...DEFAULTS, queue: ".tasks/sample/items.md", task: "sample", allowedPaths: ["out"], checks: [`"${process.execPath}" "${check}"`], checkBroker: false, piCommand: worker, runIn: "cli", parallel: 2, setup: "", autoSplit: false, deferBlocked: true, fixRounds: 0, deleteSessions: false, outageMinutes: 0, ...config };
	saveJson(join(repo, ".pi-queue/config.json"), c);
	if (Object.keys(seed).length) saveJson(join(repo, ".pi-queue/state.json"), Object.fromEntries(Object.entries(seed).map(([key, ids]) => [key, Object.fromEntries(items.filter((i) => ids.includes(i.id)).map((i) => [i.key, true]))])));
	git("add", "."); git("commit", "-m", "fixture");
	let running;
	const release = (key = "release-all") => writeFileSync(join(home, key), "");
	const events = () => (existsSync(join(home, "events")) ? readFileSync(join(home, "events"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
	const state = () => loadJson(join(repo, ".pi-queue/state.json"), {});
	const seen = (id, phase, n = 1) => events().some((e) => e.kind === "start" && e.id === id && e.phase === phase && e.n === n);
	const wait = async (predicate) => {
		const until = Date.now() + 15000;
		while (!predicate()) {
			if (Date.now() > until) assert.fail(`scheduler barrier timed out\n${JSON.stringify(state())}\n${JSON.stringify(events())}`);
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	t.after(async () => {
		release();
		if (running) { writeFileSync(join(repo, ".pi-queue/STOP"), ""); await running; }
		rmSync(home, { recursive: true, force: true });
	});
	const prompt = (id, n = 1) => (existsSync(join(home, `prompt-${id}-${n}`)) ? readFileSync(join(home, `prompt-${id}-${n}`), "utf8") : "");
	return { repo, items, git, state, events, seen, wait, release, prompt, start: () => running = main(repo) };
}

function assertSessionBound(events, parallel) {
	let active = 0;
	for (const e of events.filter((e) => e.phase !== "check")) {
		active += e.kind === "start" ? 1 : -1;
		assert.ok(active <= parallel, `more than ${parallel} agent sessions at once: ${JSON.stringify(e)}`);
	}
}

function assertPhaseBounds(events, parallel) {
	const active = { coding: 0, verification: 0 };
	for (const e of events) {
		const phase = e.phase === "check" ? "verification" : e.phase;
		active[phase] += e.kind === "start" ? 1 : -1;
		assert.ok(active[phase] >= 0 && active[phase] <= parallel, `${phase} exceeded ${parallel}: ${JSON.stringify(e)}`);
	}
	assert.deepEqual(active, { coding: 0, verification: 0 });
}

test("runner overlaps fresh coding with verification, retaining areas and verified dependency gates", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "A01", holdCheck: [1] }, { id: "B01", holdCheck: [1] },
		{ id: "C01", holdWorker: true }, { id: "D01", holdWorker: true },
		{ id: "E01", after: "A01", requires: "out/A01.txt" }, { id: "F01", area: "out/A01.txt" },
	]);
	const done = f.start();
	await f.wait(() => f.seen("A01", "check") && f.seen("B01", "check") && f.seen("C01", "coding") && f.seen("D01", "coding"));
	assert.equal(f.seen("E01", "coding"), false);
	assert.equal(f.seen("F01", "coding"), false);
	assert.equal(Object.keys(f.state().done).length, 0);
	assert.equal(Object.keys(f.state().running).length, 4);
	f.release(); await done;
	assert.equal(Object.keys(f.state().done).length, 6);
	assertPhaseBounds(f.events(), 2);
	assert.equal(f.git("status", "--porcelain"), "");
});

test("check items have independent bounded verification capacity and repo-only mode stays serialized", { timeout: 30000 }, async (t) => {
	for (const worktrees of [true, false]) {
		// parallel is the number of agent sessions: a [check] session and a coding session share it
		const parallel = worktrees ? 2 : 1;
		const f = schedulerFixture(t, [{ id: "V01", check: true, holdWorker: true }, { id: "V02", check: true }, { id: "A01", holdWorker: true }], { parallel, worktrees });
		const done = f.start();
		await f.wait(() => f.seen("V01", "verification"));
		if (worktrees) await f.wait(() => f.seen("A01", "coding") || f.seen("V02", "verification"));
		await new Promise((r) => setTimeout(r, 300));
		if (!worktrees) { assert.equal(f.seen("V02", "verification"), false); assert.equal(f.seen("A01", "coding"), false); }
		f.release(); await done;
		assert.equal(Object.keys(f.state().done).length, 3);
		assertPhaseBounds(f.events(), parallel);
		assertSessionBound(f.events(), parallel);
		if (!worktrees) {
			let active = 0;
			for (const e of f.events()) { active += e.kind === "start" ? 1 : -1; assert.ok(active <= 1); }
		}
	}
});

test("fixes release verification before reacquiring coding; waiting checks cannot deadlock", { timeout: 30000 }, async (t) => {
	for (const check of [false, true]) {
		const f = schedulerFixture(t, [{ id: "A01", check, holdCheck: [1], failChecks: [1] }, { id: "B01", holdWorker: [1] }], { parallel: 1, fixRounds: 1 });
		const done = f.start();
		await f.wait(() => f.seen("A01", "check") && f.seen("B01", "coding"));
		f.release("check-A01-1");
		await f.wait(() => Object.values(f.state().running).some((r) => r.id === "A01" && r.phase === "waiting-coding"));
		assert.equal(f.seen("A01", "coding", 2), false);
		f.release(); await done;
		assert.equal(Object.keys(f.state().done).length, 2);
		assert.equal(f.seen("A01", "coding", 2), true);
		assertPhaseBounds(f.events(), 1);
	}
});

test("disjoint parked items overlap while blocked and failed dependencies leave safe work runnable", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "A01", replies: ["BLOCKED: unavailable", "BLOCKED: unavailable"] },
		{ id: "B01", after: "A01" }, { id: "C01" },
		{ id: "P01", holdWorker: true }, { id: "P02", holdWorker: true },
	], {}, { retried: ["P01", "P02"] });
	const done = f.start();
	await f.wait(() => f.seen("P01", "coding") && f.seen("P02", "coding"));
	assert.equal(f.seen("C01", "coding"), true, "fresh work has priority over parked work");
	f.release(); await done;
	assert.equal(Object.keys(f.state().done).length, 3);
	assert.equal(Object.keys(f.state().failed).length, 2);
	assert.equal(f.seen("B01", "coding"), false);
	assertPhaseBounds(f.events(), 2);
});

test("deferred retry waits for first-pass work, without waiting on its own dependents", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "A01", replies: ["BLOCKED: waiting for B01", "DONE"], requiresAfterFirst: "out/B01.txt" },
		{ id: "B01", holdWorker: true }, { id: "C01", after: "A01" },
	]);
	const done = f.start();
	await f.wait(() => f.seen("B01", "coding") && Object.keys(f.state().deferred ?? {}).length === 1);
	assert.equal(f.seen("A01", "coding", 2), false);
	f.release(); await done;
	assert.equal(Object.keys(f.state().done).length, 3);
	assert.equal(Object.keys(f.state().failed).length, 0);
});

test("a verified repair may fully satisfy its parent without a fabricated extra edit", { timeout: 30000 }, async (t) => {
	for (const repaired of [false, true]) {
		const f = schedulerFixture(t, [{ id: "A01", noChange: true, requires: "out/A01.txt" }]);
		writeFileSync(join(f.repo, "out/A01.txt"), "already implemented\n");
		f.git("add", "out"); f.git("commit", "-m", "verified repair");
		if (repaired) {
			const line = "- [ ] A01-repair1 — Repair. Done when: correct. [areas: out/A01.txt]", repair = parseQueue(line)[0];
			saveJson(join(f.repo, ".pi-queue/state.json"), { done: { [repair.key]: "verified" }, fixes: { [f.items[0].key]: [line] }, waitFor: { [f.items[0].key]: [repair.id] } });
		}
		await f.start();
		assert.equal(!!f.state().done[f.items[0].key], repaired);
		assert.equal(f.seen("A01", "check"), repaired, "no-op acceptance still runs all checks");
		if (!repaired) assert.match(f.state().failed[f.items[0].key], /no changes/);
	}
});

test("raised coding limits still leave mandatory checks to the verification phase", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["NEEDS: 2 files, 200 lines", "DONE"] }]);
	await f.start();
	assert.equal(Object.keys(f.state().done).length, 1);
	assert.equal(f.seen("A01", "coding", 2), true);
	assert.equal(f.events().filter((e) => e.kind === "start" && e.phase === "check").length, 1);
});

test("conflict redo reacquires coding without shrinking width or blocking independent work", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "A01", path: "out/shared.txt", holdCheck: [1] },
		{ id: "B01", path: "out/shared.txt", holdWorker: [1] }, { id: "C01", holdWorker: [1] },
	]);
	const done = f.start();
	await f.wait(() => f.seen("A01", "check") && f.seen("B01", "coding") && f.seen("C01", "coding"));
	f.release("check-A01-1");
	await f.wait(() => Object.keys(f.state().done).length === 1);
	f.release("worker-B01-1");
	await f.wait(() => f.seen("B01", "coding", 2));
	assert.equal(f.state().width, 2);
	assert.equal(Object.values(f.state().running).some((r) => r.id === "C01"), true);
	f.release(); await done;
	assert.equal(Object.keys(f.state().done).length, 3);
	assert.match(f.git("branch", "--list", "queue-failed/*"), /redo/);
	assertPhaseBounds(f.events(), 2);
});

test("default failures isolate safe work; explicit finite limit halts fresh dispatch", { timeout: 30000 }, async (t) => {
	for (const limit of [0, 1]) {
		const failures = Array.from({ length: 6 }, (_, i) => ({ id: `A0${i + 1}`, replies: ["ERROR"] }));
		const f = schedulerFixture(t, [...failures, { id: "B01" }], { parallel: 1, worktrees: false, ...(limit ? { stopAfterFailuresInARow: limit } : {}) });
		await f.start();
		assert.equal(f.seen("B01", "coding"), limit === 0);
		assert.equal(Object.keys(f.state().failed).length, limit || 6);
	}
});

test("stop cancels capacity waiters without integrating or counting failures", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", holdCheck: [1], failChecks: [1] }, { id: "B01", holdWorker: [1] }, { id: "C01" }], { parallel: 1, fixRounds: 1 });
	const done = f.start();
	await f.wait(() => f.seen("A01", "check") && f.seen("B01", "coding"));
	f.release("check-A01-1");
	await f.wait(() => Object.values(f.state().running).some((r) => r.phase === "waiting-coding"));
	writeFileSync(join(f.repo, ".pi-queue/STOP"), "");
	f.release(); await done;
	assert.equal(f.seen("A01", "coding", 2), false);
	assert.equal(f.seen("C01", "coding"), false);
	assert.equal(Object.keys(f.state().done).length, 0);
	assert.equal(Object.keys(f.state().running).length, 0);
	assert.equal(f.state().failureStreak, 0);
	assert.match(f.git("branch", "--list", "queue-failed/*"), /A01/);
});

test("quarantine retains ownership and capacity while disjoint deferred work finishes", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01" }, { id: "B01", area: "out/A01.txt" }, { id: "C01" }], { autoReconcile: false }, { deferred: ["C01"] });
	saveJson(join(f.repo, ".tasks/sample/task.json"), { itemChecks: { B01: [], C01: [] } });
	f.git("add", ".tasks"); f.git("commit", "-m", "missing A01 check selection");
	await f.start();
	assert.equal(Object.values(f.state().running).filter((r) => r.quarantined).length, 1);
	assert.equal(f.seen("B01", "coding"), false);
	assert.equal(f.seen("C01", "coding"), true);
	assert.equal(Object.keys(f.state().done).length, 1);
	assert.match(f.state().phase, /quarantined/);
});

test("quarantined coding capacity cannot strand a check waiting to fix", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01" }, { id: "V01", check: true, failChecks: [1] }], { parallel: 1, fixRounds: 1, autoReconcile: false });
	saveJson(join(f.repo, ".tasks/sample/task.json"), { itemChecks: { V01: [] } });
	f.git("add", ".tasks"); f.git("commit", "-m", "quarantine fixture");
	await f.start();
	assert.equal(f.seen("V01", "verification"), true);
	assert.equal(f.seen("V01", "coding", 2), false);
	assert.equal(Object.values(f.state().running).filter((r) => r.quarantined).length, 2);
	assert.ok(Object.values(f.state().failed).some((reason) => /coding capacity quarantined/.test(reason)));
});

test("runner IPC remains best-effort when disconnected or the channel fails", (t) => {
	const connected = Object.getOwnPropertyDescriptor(process, "connected"), send = Object.getOwnPropertyDescriptor(process, "send");
	t.after(() => { for (const [key, descriptor] of [["connected", connected], ["send", send]]) { if (descriptor) Object.defineProperty(process, key, descriptor); else delete process[key]; } });
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: () => { throw Error("closed"); } });
	assert.doesNotThrow(() => notifyRunner("failure"));
	Object.defineProperty(process, "send", { configurable: true, value: (_message, callback) => callback(Error("closed asynchronously")) });
	assert.doesNotThrow(() => notifyRunner("completion"));
	Object.defineProperty(process, "connected", { configurable: true, value: false });
	Object.defineProperty(process, "send", { configurable: true, value: () => assert.fail("disconnected send") });
	notifyRunner("quarantine");
});

// ---------- 1.7: bounded growth, blockers, waiting, plan lint ----------

test("a BLOCKED item is never split; only a size stop splits, into at most splitMax parts within the growth budget", { timeout: 60000 }, async (t) => {
	const blocked = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: the plan contradicts the code"] }], { autoSplit: true });
	await blocked.start();
	assert.deepEqual(blocked.state().splits ?? {}, {});
	assert.match(Object.values(blocked.state().failed)[0], /BLOCKED/);
	assert.equal(blocked.events().filter((e) => e.kind === "start" && e.id === "A01").length, 1, "no split prompt was sent");

	const parts = (n) => Array.from({ length: n }, (_, i) => `ITEM: Part ${i + 1}. Done when: part ${i + 1} exists. [areas: out/A01${"abcdef"[i]}.txt]`).join("\n");
	// [growthMax, parts the agent proposes, parts kept] — a decomposition larger than what fits is refused whole, never cut short
	for (const [growthMax, proposed, kept] of [[0, 4, 4], [0, 6, 0], [1, 2, 2], [1, 4, 0]]) {
		const kids = ["a", "b", "c", "d"].map((x) => ({ id: `A01${x}` }));
		const f = schedulerFixture(t, [{ id: "A01", replies: ["NEEDS: 500 files, 99999 lines", parts(proposed)] }, ...kids], { autoSplit: true, growthMax });
		writeFileSync(join(f.repo, ".tasks/sample/items.md"), `- [ ] ${f.items[0].line}\n`);
		f.git("add", ".tasks"); f.git("commit", "-m", "only the parent is planned");
		await f.start();
		const state = f.state(), label = `growthMax ${growthMax}, ${proposed} proposed`;
		assert.equal(Object.values(state.splits ?? {})[0]?.length ?? 0, kept, label);
		assert.equal(Object.keys(state.done).length, kept, label);
		if (!kept) assert.match(Object.values(state.failed)[0], new RegExp(`needs ${proposed} parts but at most ${growthMax ? 2 : 4} fit`), label);
		if (!kept) assert.match(f.prompt("A01", 2), new RegExp(`2 to ${growthMax ? 2 : 4}, never more`), label);
	}
});

test("WAITING re-queues an item after the items it names; ALREADY DONE passes on the checks", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "A01", replies: ["WAITING: B01 — its helper is not there yet", "DONE"], requiresAfterFirst: "out/B01.txt" },
		{ id: "B01" },
		{ id: "C01", noChange: true, replies: ["ALREADY DONE: out/shared.txt already has it"] },
		{ id: "D01", after: "C01", requires: "out/shared.txt" },
		{ id: "E01", replies: ["WAITING: Z99 — an item that does not exist"] },
	], { parallel: 1, deferBlocked: false });
	await f.start();
	const state = f.state(), log = readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8");
	assert.equal(Object.keys(state.done).length, 4);
	assert.match(log, /WAITING A01 · needs B01 first/);
	assert.deepEqual(state.waitFor[f.items[0].key], ["B01"]);
	assert.equal(state.done[f.items[2].key], "checked");
	assert.match(state.failed[f.items[4].key], /BLOCKED.*already done or unknown/);
	assert.match(readFileSync(join(f.repo, ".pi-queue/report.md"), "utf8"), /blocked \(other\) \(1\)/);
});

test("plan lint finds merge candidates, missing dependencies and serialized plans; gaps merge into few fix items", async () => {
	const { planLint, mergeGaps, simulatePlan, failureGroups, growthBudget, growthUsed } = await import("./runner.mjs");
	const q = (lines) => parseQueue(lines.map((l) => `- [ ] ${l}`).join("\n"));
	const lint = planLint(q([
		"A01 — Change the login title. Done when: x. [areas: src/Login.tsx]",
		"A02 — Change the login label. Done when: x. [areas: src/Login.tsx]",
		"A03 — Change the login hint. Done when: x. [areas: src/Login.tsx]",
		"B01 — Use the helper from A01. Done when: y. [areas: src/b]",
		"C01 — Independent. Done when: y. [areas: src/c] [after: B01]",
	]), 4);
	assert.match(lint.findings[0], /merge A01, A02, A03/);
	assert.match(lint.findings[1], /B01 mentions A01 but has no \[after: A01\]/);
	assert.equal(lint.findings.length, 2);
	const broad = planLint(q(Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(2, "0")} — Part ${i}. Done when: x. [areas: apps/web, apps/web/f${i}.ts]`)), 4);
	assert.ok(broad.findings.some((f) => /needs about 12 rounds where 3 would do/.test(f)));
	const good = q(["A01 — a. Done when: x. [areas: src/a]", "A02 — b. Done when: x. [areas: src/b] [after: A01]", "A03 — c. Done when: x. [areas: src/c]", "V01 — check. Done when: x. [check] [areas: src] [after: *]"]);
	assert.deepEqual(planLint(good, 2).findings, []);
	assert.deepEqual(simulatePlan(good, 2), { rounds: 3, ideal: 2, criticalPath: 3 });
	const merged = mergeGaps(["Fix a. Done when: a ok. [areas: src/a]", "Fix a2. Done when: a2 ok. [areas: src/a/x.ts]", "Fix b. [areas: src/b]", "Fix c. Done when: c ok. [areas: src/c]"], 2);
	assert.equal(merged.length, 2);
	assert.match(merged[0], /Fix a; Fix a2\. Done when: a ok; and a2 ok\. \[areas: src\/a, src\/a\/x\.ts\]/);
	assert.equal(growthBudget({ growthMax: 0 }, 89), 27);
	assert.equal(growthBudget({ growthMax: 5 }, 89), 5);
	assert.equal(growthUsed({ splits: { a: ["1", "2", "3"] }, fixes: { b: ["x"] } }), 3);
	const items = q(["A01 — a. Done when: x. [areas: a]", "B01 — b. Done when: x. [areas: b] [after: A01]", "C01 — c. Done when: x. [areas: c] [after: B01]"]);
	const groups = failureGroups(items, { failed: { [items[0].key]: "agent: BLOCKED: decision: which tier?", [items[1].key]: "depends on A01, which failed", [items[2].key]: "depends on B01, which failed" } });
	assert.equal(groups.waiting, 2);
	assert.deepEqual(groups.groups.map((g) => [g.kind, g.items[0].id, g.items[0].blocks]), [["needs your decision", "A01", 2]]);
});

test("tiers, task limits and manual limits/skip/answer-style controls resolve per item", () => {
	const c = { ...DEFAULTS, model: "example/large", thinking: "high", tiers: { light: { model: "example/small", thinking: "low", itemMinutes: 15 } } };
	const light = itemConfig(c, item("[tier: light]"));
	assert.deepEqual([light.model, light.thinking, light.itemMinutes, light.maxNetLines], ["example/small", "low", 15, 150]);
	assert.equal(itemConfig(c, item("[tier: light] [thinking: high]")).thinking, "high", "an explicit tag wins over the tier");
	assert.throws(() => itemConfig(c, item("[tier: turbo]")), /unknown \[tier: turbo\]/);
	assert.doesNotMatch(item("[tier: light]").title, /tier/);
	const items = parseQueue("- [ ] A01 root [areas: a]\n- [ ] B01 child [areas: b] [after: A01]");
	const state = { done: {}, failed: { [items[0].key]: "agent: BLOCKED: env: no key", [items[1].key]: "depends on A01, which failed" } };
	assert.deepEqual(applyControl(state, items, { action: "limits", ids: ["A01"], limits: { maxNetLines: 900, bogus: 1 }, by: "user" }), ["A01", "B01"]);
	assert.deepEqual(state.limits[items[0].key], { maxNetLines: 900 });
	assert.deepEqual(state.failed, {});
	state.failed[items[0].key] = "check failed";
	applyControl(state, items, { action: "skip", ids: ["A01"], by: "user" });
	assert.equal(state.done[items[0].key], "skipped");
	assert.deepEqual(state.failed, {});
});

test("handoff applies plan limits and tiers, and returns plan-lint findings until they are fixed or accepted", async (t) => {
	const { handoff } = await import("./extension.ts");
	const root = fixture(t), dir = join(root, ".tasks", "sample");
	mkdirSync(dir, { recursive: true });
	for (const f of ["brief.md", "rules.md", "questions.md"]) writeFileSync(join(dir, f), "");
	const ctx = { modelRegistry: { getAvailable: () => [model] } };
	const base = { allowedPaths: ["src/"], checks: ["must-not-run"] };
	const lines = ["A01 — Title. Done when: x. [areas: src/a.ts] [tier: light]", "A02 — Label. Done when: x. [areas: src/a.ts]", "A03 — Hint. Done when: x. [areas: src/a.ts]"];
	writeFileSync(join(dir, "items.md"), lines.map((l) => `- [ ] ${l}`).join("\n"));
	for (const [task, error] of [
		[{ ...base, tiers: { light: { model: "example/missing" } } }, /tier "light": model example\/missing is not available/],
		[{ ...base, tiers: { light: { model: "example/small", thinking: "high" } } }, /tier "light": high is not supported/],
		[{ ...base, tiers: { light: { model: "example/small" } }, limits: { maxNetLines: -5 } }, /"limits" may only set positive integers/],
		[{ ...base }, /unknown \[tier: light\]/],
		[{ ...base, tiers: { light: { model: "example/small" } } }, /plan: merge A01, A02, A03/],
	]) {
		writeFileSync(join(dir, "task.json"), JSON.stringify(task));
		const result = await handoff(root, "sample", ctx);
		assert.equal(result.ok, false);
		assert.match(result.text, error);
		assert.doesNotMatch(result.text, /checks fail/);
	}
	writeFileSync(join(dir, "task.json"), JSON.stringify({ ...base, model: "example/small", thinking: "off", tiers: { light: { model: "example/small" } }, planLint: "accept: three deliberate review points" }));
	assert.match((await handoff(root, "sample", ctx)).text, /checks fail|must-not-run/, "accepted lint proceeds to the checks");
});

// ---------- 1.8: unattended recovery inside a run ----------

test("a runner error frees its slot at once: work is preserved, the item is tried again, other items keep running", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01" }, { id: "B01", area: "out/A01.txt" }, { id: "C01" }], { parallel: 1 });
	saveJson(join(f.repo, ".tasks/sample/task.json"), { itemChecks: { B01: [], C01: [] } }); // A01 has no check selection: a deterministic runner error
	f.git("add", ".tasks"); f.git("commit", "-m", "missing A01 check selection");
	await f.start();
	const state = f.state(), log = readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8");
	assert.deepEqual(state.running, {}, "no slot stays quarantined");
	assert.equal(state.runnerErrors[f.items[0].key], 3, "requeued twice, then left failed");
	assert.match(state.failed[f.items[0].key], /^runner error/);
	assert.equal(f.seen("C01", "coding"), true);
	assert.ok(state.done[f.items[2].key]);
	assert.match(state.failed[f.items[1].key] ?? "", /depends on|^$/);
	assert.equal(state.phase, "finished");
	assert.match(log, /RECONCILED A01/);
});

test("a provider error before any work is waited out in the same session instead of failing the item", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["ERROR", "ERROR", "DONE"] }, { id: "B01" }], { parallel: 2, outageMinutes: 5, outagePauses: [0.05] });
	await f.start();
	const state = f.state(), log = readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8");
	assert.equal(Object.keys(state.done).length, 2);
	assert.deepEqual(state.failed, {});
	assert.equal((log.match(/PROVIDER A01/g) ?? []).length, 2);
});

// ---------- 1.8.1: the false-DONE incident (Y01: "kept TS6, lock additions exceed the cap" reported as DONE) ----------

test("a size stop is never answered with 'make it fit': with no level left the item fails instead of shrinking and passing", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["NEEDS: 5 files, 216 lines", "DONE\n- out/A01.txt: kept TS6 so it fits"] }], { escalate: [], autoSplit: false, fixRounds: 2 });
	await f.start();
	assert.equal(f.seen("A01", "coding", 2), false, "no second turn asked it to squeeze under the limit");
	assert.deepEqual(f.state().done, {});
	assert.match(Object.values(f.state().failed)[0], /NEEDS 5 files, 216 lines/);
});

test("lockfile lines never count toward the size limit", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", write: { "out/pnpm-lock.yaml": 400, "out/__snapshots__/a.snap": 300 } }], { maxNetLines: 20, escalate: [], autoSplit: false });
	await f.start();
	assert.equal(Object.keys(f.state().done).length, 1, JSON.stringify(f.state().failed) + readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"));
	const { isGenerated } = await import("./runner.mjs");
	assert.equal(isGenerated("apps/web/package-lock.json"), true);
	assert.equal(isGenerated("src/lock.ts"), false);
	assert.equal(isGenerated("gen/api.ts", ["gen"]), true);
});

test("a DONE that admits a shortfall gets one confirmation turn: NEEDS then fails it, DONE: CONFIRMED passes it", { timeout: 30000 }, async (t) => {
	const admit = "DONE\n- out/A01.txt: retained the original compiler because the lock additions exceed the line cap";
	const f = schedulerFixture(t, [
		{ id: "A01", replies: [admit, "NEEDS: 5 files, 216 lines"] },
		{ id: "B01", replies: [admit.replace("A01", "B01"), "DONE: CONFIRMED\n- the compiler is replaced in out/B01.txt"] },
		{ id: "C01", replies: ["DONE\n- out/C01.txt: wrote the new value"] },
	], { escalate: [], autoSplit: false });
	await f.start();
	const state = f.state(), log = readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8");
	assert.match(state.failed[f.items[0].key], /NEEDS/);
	assert.ok(state.done[f.items[1].key]);
	assert.ok(state.done[f.items[2].key]);
	assert.equal(f.seen("C01", "coding", 2), false, "an ordinary DONE is not questioned");
	assert.match(f.prompt("A01", 2), /exceed the line cap[\s\S]*reads as if part of the item was not done/);
	assert.equal((log.match(/CONFIRM /g) ?? []).length, 2);
	assert.match(f.prompt("A01", 1), /Never keep the old implementation/);
});

test("a [check] still runs when an item it covers failed, and audits passed items by the code", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: env: no staging key"] }, { id: "B01" }, { id: "V01", check: true, after: "A01, B01" }], { deferBlocked: false });
	await f.start();
	const state = f.state();
	assert.ok(state.done[f.items[2].key], JSON.stringify(state.failed));
	assert.match(f.prompt("V01"), /These covered items FAILED[\s\S]*A01 \(agent: BLOCKED: env: no staging key\)/);
	assert.match(f.prompt("V01"), /not by its DONE message/);
});

test("plan lint rejects a Done when with an escape hatch; handoff does not inherit a disabled escalation", async (t) => {
	const { planLint } = await import("./runner.mjs");
	const q = (lines) => parseQueue(lines.map((l) => `- [ ] ${l}`).join("\n"));
	const lint = planLint(q([
		"Y01 — Adopt TS7 for typecheck. Done when: native typecheck uses TS7; unavailable/incompatible/slower means keep original compiler and report why. [areas: apps/a]",
		"L01 — Migrate lint. Done when: lint runs Oxlint and preserves all existing ESLint rules. [areas: apps/b]",
	]), 2);
	assert.equal(lint.findings.length, 1);
	assert.match(lint.findings[0], /^Y01: its "Done when" passes without the change/);
	const { carriedConfig } = await import("./extension.ts");
	const kept = carriedConfig({ escalate: [], autoSplit: false, fixRounds: 0, maxNetLines: 10, parallel: 3, piWebUrl: "http://x", runIn: "cli", manager: false, setup: "make deps" });
	assert.deepEqual(kept, { parallel: 3, piWebUrl: "http://x", runIn: "cli", manager: false, setup: "make deps" });
});

// ---------- 1.8.2: independent audit findings ----------

test("recovery never resets a worktree whose work could not be preserved", { timeout: 30000 }, async (t) => {
	const { reconcileInterrupted, preserveWork } = await import("./runner.mjs");
	const f = schedulerFixture(t, [{ id: "A01" }]);
	const wt = join(f.repo, ".pi-queue/worktrees/w0");
	f.git("worktree", "add", "--detach", wt, "main");
	writeFileSync(join(wt, "out/half.txt"), "unsaved work\n");
	const lock = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], { cwd: wt, encoding: "utf8" }).trim();
	writeFileSync(lock.startsWith("/") ? lock : join(wt, lock), ""); // every index write fails: add and commit cannot succeed
	const state = { running: { 0: { id: "A01", key: f.items[0].key, worktree: wt } }, failed: {} };
	const left = await reconcileInterrupted({ repo: f.repo, c: DEFAULTS, state, save: () => {}, log: () => {}, branch: "main" });
	assert.equal(left.length, 1);
	assert.match(left[0], /could not keep its work \(git add/);
	assert.equal(readFileSync(join(wt, "out/half.txt"), "utf8"), "unsaved work\n", "nothing was reset");
	assert.ok(state.running[0], "the slot stays reserved");
	assert.equal(f.git("branch", "--list", "queue-failed/*").trim(), "");
	rmSync(lock.startsWith("/") ? lock : join(wt, lock));
	const ok = await preserveWork(f.repo, wt, "queue-failed/kept", "keep", true);
	assert.equal(ok.name, "queue-failed/kept");
	assert.match(f.git("show", "queue-failed/kept:out/half.txt"), /unsaved work/);
});

test("a Pi Web worker counts as stopped only when its server refuses connections", { timeout: 60000 }, async (t) => {
	const { reconcileInterrupted } = await import("./runner.mjs");
	const http = await import("node:http"), net = await import("node:net");
	const hanging = http.createServer(() => {}); // accepts, never answers
	await new Promise((r) => hanging.listen(0, "127.0.0.1", r));
	const closed = net.createServer(); await new Promise((r) => closed.listen(0, "127.0.0.1", r));
	const closedPort = closed.address().port; await new Promise((r) => closed.close(r));
	t.after(() => hanging.close());
	const agentDir = mkdtempSync(join(tmpdir(), "pi-flow-agent-")), before = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; rmSync(agentDir, { recursive: true, force: true }); });
	const f = schedulerFixture(t, [{ id: "A01" }]);
	const c = { ...DEFAULTS, piWebUrl: `http://127.0.0.1:${closedPort}`, worktrees: false };
	for (const [webUrl, reclaimed] of [[`http://127.0.0.1:${closedPort}`, true], [`http://127.0.0.1:${hanging.address().port}`, false], [undefined, false]]) {
		const state = { running: { 0: { id: "A01", key: f.items[0].key, worktree: f.repo, web: true, sessionId: "s1", ...(webUrl ? { webUrl } : {}) } }, failed: {} };
		const left = await reconcileInterrupted({ repo: f.repo, c, state, save: () => {}, log: () => {}, branch: "main" });
		assert.equal(left.length === 0, reclaimed, String(webUrl));
		assert.equal(!state.running[0], reclaimed, String(webUrl));
	}
});

// ---------- 1.9: the overnight failures (stuck on one item, 2 slots of 20, RAM, no updates) ----------

test("read-only audits lock nothing, run side by side, and hand their findings to the items after them", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [
		{ id: "R01", readonly: true, noChange: true, area: "out", replies: ["DONE\nFinding: the login form has no rate limit."] },
		{ id: "R02", readonly: true, noChange: true, area: "out", replies: ["DONE\nFinding: none."] },
		{ id: "R03", readonly: true, area: "out" }, // changes a file: a read-only item must not
		{ id: "F01", after: "R01, R02" },
	], { parallel: 3 });
	await f.start();
	const state = f.state();
	assert.ok(state.done[f.items[0].key] && state.done[f.items[1].key] && state.done[f.items[3].key], JSON.stringify(state.failed));
	assert.match(state.failed[f.items[2].key], /read-only item changed files/);
	assert.match(readFileSync(join(f.repo, ".pi-queue/reports/R01.md"), "utf8"), /no rate limit/);
	assert.match(f.prompt("F01"), /Findings of the read-only items you depend on[\s\S]*reports\/R01\.md/);
	assert.match(f.prompt("R01"), /This item is READ-ONLY/);
	const starts = f.events().filter((e) => e.kind === "start" && /^R0/.test(e.id)).length;
	assert.equal(starts, 3);
	const { simulatePlan } = await import("./runner.mjs");
	assert.equal(simulatePlan(parseQueue(Array.from({ length: 9 }, (_, i) => `- [ ] R${i + 1} — audit ${i}. Done when: x. [areas: apps] [readonly]`).join("\n")), 9).rounds, 1);
});

test("a released failure lets the items after it run, told what is missing; WAITING on a failed item blocks at once", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01" }, { id: "B01", after: "A01" }, { id: "C01", replies: ["WAITING: A01 — needs its helper"] }], { parallel: 1, deferBlocked: false });
	const a = f.items[0];
	saveJson(join(f.repo, ".pi-queue/state.json"), { done: {}, failed: { [a.key]: "check failed: boom" }, released: { [a.key]: "check failed: boom" } });
	await f.start();
	const state = f.state();
	assert.ok(state.done[f.items[1].key], JSON.stringify(state.failed));
	assert.match(f.prompt("B01"), /These prerequisites FAILED and will not be retried[\s\S]*A01 \(check failed: boom\)/);
	assert.match(state.failed[f.items[2].key], /BLOCKED/);
	assert.equal(f.seen("C01", "coding", 2), false);
	// the control itself reopens dependents that already failed on the prerequisite
	const items = parseQueue("- [ ] A01 a [areas: a]\n- [ ] B01 b [areas: b] [after: A01]\n- [ ] B02 c [areas: c] [after: A01]");
	const st = { done: {}, failed: { [items[0].key]: "x", [items[1].key]: "depends on A01, which failed", [items[2].key]: "depends on A01, which failed" } };
	assert.deepEqual(applyControl(st, items, { action: "release", ids: ["A01"], by: "auto" }), ["A01", "B01", "B02"]);
	assert.deepEqual(Object.keys(st.failed), [items[0].key]);
});

test("retries run stronger: heavy tier, high effort, more time; provider errors are not boosted", () => {
	const items = parseQueue("- [ ] A01 a [areas: a]\n- [ ] B01 b [areas: b]");
	const st = { done: {}, failed: { [items[0].key]: "check failed: x", [items[1].key]: "pi exited with an error" } };
	applyControl(st, items, { action: "retry", ids: [], by: "user" });
	assert.deepEqual(st.boost, { [items[0].key]: 1 });
	const c = boosted({ ...DEFAULTS, model: "p/light", thinking: "low", itemMinutes: 40, tiers: { heavy: { model: "p/big", thinking: "high" } } }, 1);
	assert.deepEqual([c.model, c.thinking, c.itemMinutes], ["p/big", "high", 60]);
	assert.equal(boosted({ ...DEFAULTS, model: "p/one", thinking: "medium" }, 2).model, "p/one");
});

test("processes left running in a worktree are stopped", { timeout: 20000 }, async (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-flow-stray-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { spawn } = await import("node:child_process");
	const server = spawn("sleep", ["60"], { cwd: dir, detached: true, stdio: "ignore" });
	server.unref();
	await new Promise((r) => setTimeout(r, 300));
	assert.ok((await straysIn(dir)).includes(server.pid));
	const lines = [];
	assert.equal(await killStrays(dir, (l) => lines.push(l), "A01"), 1);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal((await straysIn(dir)).length, 0);
	assert.match(lines[0], /CLEANUP A01 · stopped 1 process/);
});

test("with too little free memory no further item starts until running ones finish", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", holdWorker: true }, { id: "B01" }, { id: "C01" }], { parallel: 3, minFreeMemoryGB: 1e9 });
	f.start();
	await f.wait(() => f.seen("A01", "coding"));
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(f.seen("B01", "coding"), false, "B01 waits while A01 runs");
	f.release("worker-A01-1");
	await f.wait(() => Object.keys(f.state().done ?? {}).length === 3);
	assert.match(readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"), /MEMORY .* not starting more items/);
});

test("progress report: counts, pace, what needs you, and a loud line when the queue stopped", async (t) => {
	const { progressReport } = await import("./extension.ts");
	const root = fixture(t);
	mkdirSync(join(root, ".pi-queue"), { recursive: true });
	mkdirSync(join(root, ".tasks/sample"), { recursive: true });
	writeFileSync(join(root, ".tasks/sample/items.md"), "- [ ] A01 — a. Done when: x. [areas: a]\n- [ ] B01 — b. Done when: x. [areas: b]\n- [ ] C01 — c. Done when: x. [areas: c]\n");
	saveJson(join(root, ".pi-queue/config.json"), { task: "sample", queue: ".tasks/sample/items.md" });
	const items = parseQueue(readFileSync(join(root, ".tasks/sample/items.md"), "utf8"));
	saveJson(join(root, ".pi-queue/state.json"), { startedAt: 1, done: { [items[0].key]: "abc" }, failed: { [items[1].key]: "agent: BLOCKED: decision: which layout?" } });
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");
	writeFileSync(join(root, ".pi-queue/log.md"), `- ${now} PASS A01 · abc\n- ${now} release B01 · out of automatic retries\n- ${now} END · passed 1\n`);
	const r = progressReport(root);
	assert.match(r.text, /1\/3 landed · 1 failed · 0 never started \(a prerequisite failed\) · 1 open/);
	assert.match(r.text, /1 passed in the last hour/);
	assert.match(r.text, /⚠ the queue is NOT running \(1 items open\)/);
	assert.match(r.text, /Needs you: needs your decision: B01/);
	assert.match(r.text, /release B01/);
	assert.equal(r.urgent, true);
});

test("background pi: parallel RPC processes serve every item, turn and worktree, and none is left running", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01" }, { id: "A02" }, { id: "A03" }, { id: "A04", replies: ["DONE"], failChecks: [1] }, { id: "A05" }], { parallel: 1, fixRounds: 1 });
	await f.start();
	const starts = readFileSync(join(f.repo, "..", "rpc-starts"), "utf8").trim().split("\n").map(Number);
	assert.equal(starts.length, 1, "parallel 1: one pi process serves both worktrees");
	assert.equal(Object.keys(f.state().done).length, 5);
	assert.ok(f.events().filter((e) => e.kind === "start" && e.phase === "coding").length >= 6, "the fix turn ran in the same process");
	for (const pid of starts) assert.equal(pidAlive(pid), false, "the worker exits when the run ends");
});

test("paths, widenable and reworkable helpers", () => {
	assert.deepEqual(mentionedPaths("edit apps/web/src/a.ts and ./pkg/b.go, see https://x.dev/a/b and v1/2"), ["apps/web/src/a.ts", "pkg/b.go"]);
	assert.equal(widenable("apps/api/x.ts"), true);
	for (const p of [".env", "apps/.env.local", ".github/workflows/ci.yml", "../x", "/etc/passwd", "config/secrets.json", "a/b.pem", ".pi-queue/state.json"]) assert.equal(widenable(p), false, p);
	assert.equal(reworkable("agent: BLOCKED: out/x.txt does not exist"), true);
	assert.equal(reworkable("check failed: go test ./..."), true);
	for (const r of ["timed out after 40 min", "pi exited with an error (code 1)", "agent: BLOCKED: decision: which API?", "agent: BLOCKED: env: no docker", "needs you: reworked 2× and still failing", "stopped by request"]) assert.equal(reworkable(r), false, r);
});

test("full autonomy: a change that needs files outside the allowed paths is kept and the files are allowed, logged for review", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", write: { "lib/helper.txt": 3 } }], { parallel: 1 });
	await f.start();
	const st = f.state(), key = f.items[0].key;
	assert.ok(st.done[key], JSON.stringify(st.failed) + readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"));
	assert.deepEqual(st.scope[key], ["lib/helper.txt"]);
	assert.match(readFileSync(join(f.repo, ".pi-queue/decisions.md"), "utf8"), /Scope widened for this item: lib\/helper\.txt/);
	assert.match(readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"), /SCOPE A01 · also allowed: lib\/helper\.txt/);
	assert.equal(f.events().filter((e) => e.kind === "start" && e.id === "A01" && e.phase !== "check").length, 1, "no second session: the work was judged again\n" + readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"));
	// ask: no widening; rework looks at it and gives up, so the failure says it needs you
	const g = schedulerFixture(t, [{ id: "A01", write: { "lib/helper.txt": 3 } }], { parallel: 1, autonomy: "ask" });
	await g.start();
	assert.match(g.state().failed[g.items[0].key], /^needs you: no idea \(rework\) · files outside out: lib\/helper\.txt/);
});

test("a scope blocker outside item areas but within the task grant continues on the exact file", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: `out/shared.txt` is outside the item's areas"], path: "out/shared.txt" }]);
	await f.start();
	const key = f.items[0].key;
	assert.ok(f.state().done[key], JSON.stringify(f.state().failed));
	assert.deepEqual(f.state().scope[key], ["out/shared.txt"]);
	assert.match(f.prompt("A01", 2), /You may now also change: out\/shared\.txt/);
	assert.ok(f.seen("A01", "check"));
});

test("a scope blocker cannot grant a protected path, a folder, or override a task opt-out", { timeout: 30000 }, async (t) => {
	for (const [path, config] of [["out/.env.local", {}], [".tasks/sample", {}], ["out", {}], ["out/shared.txt", { widenScope: false }]]) {
		const f = schedulerFixture(t, [{ id: "A01", replies: [`BLOCKED: scope: ${path}`] }], { rework: false, ...config });
		await f.start();
		assert.ok(f.state().failed[f.items[0].key], path);
		assert.equal(f.prompt("A01", 2), "", path);
	}
});

test("rework rewrites a failed item from the code, and the rewritten item runs instead of the old one", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: out/config/settings.txt does not exist"], rework: ["REWRITE: Put the setting in out/A01.txt (there is no out/config). Done when: out/A01.txt has the setting. [areas: out/A01.txt]\nEvidence: ls out"] }], { parallel: 1 });
	await f.start();
	const st = f.state(), key = f.items[0].key;
	assert.ok(st.done[key], JSON.stringify(st.failed));
	assert.equal(st.reworks[key], 1);
	assert.match(st.rewrites[key], /^A01 — Put the setting in out\/A01\.txt .*Done when: out\/A01\.txt has the setting\. \[areas: out\/A01\.txt\]/);
	assert.match(f.prompt("A01", 2), /ITEM: A01 — Put the setting in out\/A01\.txt/);
	assert.match(f.prompt("A01", 2), /## Rework \(fresh read-only session\)/, "the next worker sees the diagnosis");
	assert.match(readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"), /REWORK A01 · agent: BLOCKED: out\/config\/settings\.txt does not exist → rewritten: Put the setting/);
	assert.match(readFileSync(join(f.repo, ".pi-queue/decisions.md"), "utf8"), /Reworked after: agent: BLOCKED[\s\S]*Was: A01 — A01\.[\s\S]*Now: A01 — Put the setting/);
});

test("a missing file another open item provides makes the item wait for it, without a rework session", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: out/B01.txt does not exist yet"] }, { id: "B01", holdWorker: true }], { parallel: 1 });
	const done = f.start();
	await f.wait(() => f.state().waitFor?.[f.items[0].key]?.includes("B01"));
	f.release();
	await done;
	const st = f.state();
	assert.equal(Object.keys(st.done).length, 2, JSON.stringify(st.failed));
	assert.equal(existsSync(join(f.repo, "..", "reworks")), false, "no model session was needed");
	assert.match(readFileSync(join(f.repo, ".pi-queue/log.md"), "utf8"), /REWORK A01 · .* → waits for B01 \(they provide out\/B01\.txt\)/);
});

test("rework is bounded: after maxReworks the item fails for you; GIVE UP fails it at once with the reason", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: nope", "BLOCKED: still no", "BLOCKED: never"], rework: ["REWRITE: Try out/A01.txt. Done when: it exists. [areas: out/A01.txt]", "REWRITE: Try harder on out/A01.txt. Done when: it exists. [areas: out/A01.txt]"] }], { parallel: 1 });
	await f.start();
	const key = f.items[0].key;
	assert.match(f.state().failed[key], /^needs you: reworked 2× and still failing · agent: BLOCKED: never/);
	assert.equal(readFileSync(join(f.repo, "..", "reworks"), "utf8").trim().split("\n").length, 2);
	const g = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: the API key for the payment sandbox is not in the repo"], rework: ["GIVE UP: needs a sandbox key only you have"] }], { parallel: 1 });
	await g.start();
	assert.match(g.state().failed[g.items[0].key], /^needs you: needs a sandbox key only you have \(rework\)/);
	// a rework that only repeats the item is not a rework
	const h = schedulerFixture(t, [{ id: "A01", replies: ["BLOCKED: hmm"], rework: [`REWRITE: A01. Done when: verified. [areas: out/A01.txt]`] }], { parallel: 1 });
	await h.start();
	assert.match(h.state().failed[h.items[0].key], /could only repeat the item unchanged/);
});

// The six findings of a real V90 check (shapes kept, names shortened). Two valid four-file findings share one fixture:
// the old merge turned them into one seven-file job in a task that allows five.
const V90 = [
	"Owner list reuses the shared table. Done when: the list renders from TableShell. [areas: apps/admin/src/owners/List.tsx, apps/admin/src/owners/Row.tsx, apps/admin/src/owners/index.ts, apps/admin/test/fixtures/admin.ts]",
	"Invoice list reuses the shared table. Done when: invoices render from TableShell. [areas: apps/admin/src/invoices/List.tsx, apps/admin/src/invoices/Row.tsx, apps/admin/src/invoices/index.ts, apps/admin/test/fixtures/admin.ts]",
	"Drop the duplicate date helper. Done when: one formatDate. [areas: apps/admin/src/lib/date.ts]",
	"Receipt button label. Done when: the label reads Download receipt. [areas: apps/admin/src/receipts/Button.tsx]",
	"Empty state copy. Done when: the empty state says No members yet. [areas: apps/admin/src/members/Empty.tsx]",
	"Settings fixture is stale. Done when: the settings test passes. [areas: apps/admin/test/fixtures/settings.ts]",
];

test("V90 replay: no generated fix job exceeds the file limit, findings that share a fixture stay separate, none is dropped", () => {
	const plan = planGapJobs(V90, { room: 3, maxFiles: 5, allowedPaths: ["apps/admin"] });
	const files = (l) => l.match(/\[areas: ([^\]]+)\]/)[1].split(", ");
	for (const job of [...plan.jobs, ...plan.leftover]) assert.ok(files(job).length <= 5, job);
	assert.ok(!plan.jobs.some((j) => /Owner list/.test(j) && /Invoice list/.test(j)), "the two fixture-sharing findings are never one job");
	const covered = [...plan.jobs, ...plan.leftover].join("\n");
	for (const g of V90) assert.ok(covered.includes(g.split(". Done when")[0]), `dropped: ${g.slice(0, 40)}`);
	assert.equal(plan.jobs.length, 3);
	// with room for two jobs, the two four-file findings cannot absorb the rest: one waits for the next round
	const tight = planGapJobs(V90, { room: 2, maxFiles: 5, allowedPaths: ["apps/admin"] });
	assert.equal(tight.jobs.length, 2);
	assert.ok(tight.leftover.length >= 1);
	for (const job of [...tight.jobs, ...tight.leftover]) assert.ok(files(job).length <= 5, job);
	// the two that share the fixture overlap, so they run one after the other, not at once
	const owners = parseQueue(`- [ ] V90-fix1 — ${[...plan.jobs, ...plan.leftover].find((j) => /Owner list/.test(j))}`)[0];
	const invoices = parseQueue(`- [ ] V90-fix2 — ${[...plan.jobs, ...plan.leftover].find((j) => /Invoice list/.test(j))}`)[0];
	assert.equal(areasOverlap(owners.areas, invoices.areas), true);
	// outside the allowed paths, or without areas: rejected before any worker, with the reason
	const bad = planGapJobs(["Fix CI. Done when: green. [areas: .github/workflows/ci.yml]", "Fix it. Done when: ok."], { room: 3, maxFiles: 5, allowedPaths: ["apps/admin"] });
	assert.deepEqual(bad.jobs, []);
	assert.deepEqual(bad.rejected.map((r) => r.why), ["outside the allowed paths: .github/workflows/ci.yml", "no [areas: …]"]);
	// one finding that alone needs more files starts at what it needs, never by merging
	const big = planGapJobs(["Rename across six. Done when: done. [areas: a/1.ts, a/2.ts, a/3.ts, a/4.ts, a/5.ts, a/6.ts]"], { room: 3, maxFiles: 5 });
	assert.match(big.jobs[0], /\[files=6\]$/);
});

test("admission: generated jobs need Done when, areas in scope, a file count within the limit, resolvable checks and known prerequisites", () => {
	const c = { ...DEFAULTS, allowedPaths: ["apps/admin"], checks: ["git diff --check"], itemChecks: { V90: ["pnpm --filter admin test"] } };
	const items = parseQueue("- [ ] V90 — check. Done when: x. [areas: apps/admin] [check]");
	assert.equal(admissionProblem("V90-fix1 — Fix a. Done when: ok. [areas: apps/admin/a.ts]", c, items), undefined);
	assert.equal(itemConfig(c, parseQueue("- [ ] V90-fix1 — Fix a. Done when: ok. [areas: apps/admin/a.ts]")[0]).checks.at(-1), "pnpm --filter admin test", "the fix uses V90's focused checks");
	assert.match(admissionProblem("X01-fix1 — Fix a. Done when: ok. [areas: apps/admin/a.ts]", c, items), /focused itemChecks/);
	assert.match(admissionProblem("V90-fix1 — Fix a. [areas: apps/admin/a.ts]", c, items), /no "Done when"/);
	assert.match(admissionProblem("V90-fix1 — Fix a. Done when: ok. [areas: apps/web/a.ts]", c, items), /outside the allowed paths/);
	assert.match(admissionProblem(`V90-fix1 — Fix a. Done when: ok. [areas: ${Array.from({ length: 7 }, (_, i) => `apps/admin/f${i}.ts`).join(", ")}]`, c, items), /names 7 files, more than its limit of 5/);
	assert.equal(admissionProblem(`V90-fix1 — Fix a. Done when: ok. [areas: ${Array.from({ length: 7 }, (_, i) => `apps/admin/f${i}.ts`).join(", ")}] [files=7]`, c, items), undefined);
	assert.match(admissionProblem("V90-fix1 — Fix a. Done when: ok. [areas: apps/admin/a.ts] [after: Z09]", c, items), /unknown items: Z09/);
	assert.match(admissionProblem("V90 — again. Done when: ok. [areas: apps/admin/a.ts]", c, items), /already used/);
	assert.deepEqual(checkOwners("V90a-fix1"), ["V90a-fix1", "V90a", "V90"]);
});

test("a [check] whose findings go through the queue: every fix job is within limits, and the check passes only after all of them", { timeout: 30000 }, async (t) => {
	const gaps = ["GAP: First. Done when: a. [areas: out/a1.txt, out/a2.txt, out/a3.txt, out/fixture.txt]", "GAP: Second. Done when: b. [areas: out/b1.txt, out/b2.txt, out/b3.txt, out/fixture.txt]", "GAP: Third. Done when: c. [areas: out/c.txt]"];
	const f = schedulerFixture(t, [{ id: "V90", check: true, area: "out", replies: [gaps.join("\n"), "DONE"] }], { parallel: 2, maxGapItems: 3 });
	await f.start();
	const st = f.state(), v90 = f.items[0];
	const fixes = st.fixes[v90.key].map((l) => parseQueue(l)[0]);
	assert.equal(fixes.length, 3);
	for (const fx of fixes) assert.ok(fx.areas.length <= 5, fx.line);
	const all = allItems(readFileSync(join(f.repo, ".tasks/sample/items.md"), "utf8"), st);
	assert.ok(all.every((i) => st.done[i.key]), JSON.stringify(st.failed));
	const ev = f.events();
	const lastFix = Math.max(...fixes.map((fx) => ev.findLastIndex((e) => e.id === fx.id && e.kind === "end")));
	assert.ok(ev.findLastIndex((e) => e.id === "V90" && e.kind === "start" && e.phase !== "check") > lastFix, "V90 checks again after every fix");
});

test("[produces]: passing checks without the declared output is not a pass, and the item that needs it never starts", { timeout: 30000 }, async (t) => {
	const f = schedulerFixture(t, [{ id: "B01", tags: "[produces: out/B01-baseline.md]", area: "out" }, { id: "T00", after: "B01" }], { parallel: 1, fixRounds: 1 });
	await f.start();
	const st = f.state(), [b01, t00] = f.items;
	assert.match(st.failed[b01.key], /required output missing: out\/B01-baseline\.md|needs you: .*required output missing/);
	assert.equal(st.failed[t00.key], "depends on B01, which failed");
	assert.equal(f.events().some((e) => e.id === "T00"), false, "no worker spent on T00");
	assert.match(runReport(allItems(readFileSync(join(f.repo, ".tasks/sample/items.md"), "utf8"), st), st), /\*\*0 landed\*\* · \*\*1 failed\*\* \(1 need you\) · \*\*1 never started\*\*/);
	// once B01 no longer fails, T00 opens again by itself
	delete st.failed[b01.key];
	st.done[b01.key] = "abc";
	assert.deepEqual(reopenDependents(st, allItems(readFileSync(join(f.repo, ".tasks/sample/items.md"), "utf8"), st)), ["T00"]);
	assert.equal(st.failed[t00.key], undefined);
	// with the output written, it passes and its consumer runs
	const g = schedulerFixture(t, [{ id: "B01", tags: "[produces: out/B01-baseline.md]", area: "out", write: { "out/B01-baseline.md": 3 } }, { id: "T00", after: "B01" }], { parallel: 1 });
	await g.start();
	assert.equal(Object.keys(g.state().done).length, 2, JSON.stringify(g.state().failed));
});

// Review regressions: executable TODOs until the runner enforces these contracts.
test("review: V90 cannot land while a reported finding has no job", { todo: "A0: a count does not preserve the leftover finding" }, async (t) => {
	const gap = (p) => `GAP: Repair ${p}. Done when: corrected. [areas: out/${p}1.txt, out/${p}2.txt, out/${p}3.txt]`;
	const f = schedulerFixture(t, [{ id: "V90", check: true, area: "out", replies: [[gap("a"), gap("b")].join("\n"), "DONE"] }], { parallel: 1, maxGapItems: 1, maxFilesGrowing: 5 });
	await f.start();
	const st = f.state(), key = f.items[0].key;
	assert.ok(!st.done[key] || st.fixes[key].some((line) => line.includes("out/b1.txt")), "V90 passed without ever scheduling finding b");
});

test("review: a rejected first-round finding does not take its valid sibling down", { todo: "A1: notes directory does not exist yet" }, async (t) => {
	const f = schedulerFixture(t, [{ id: "V90", check: true, area: "out", replies: ["GAP: Fix A. Done when: verified. [areas: out/a.txt]\nGAP: Needs scope. Done when: verified. [areas: other/b.txt]", "DONE"] }], { parallel: 1 });
	await f.start();
	assert.ok(f.seen("V90-fix1", "coding"), "the admitted sibling never ran");
});

test("an old config updates once when idle, preserving choices, backup and effective approval", async (t) => {
	const { updateQueueConfig } = await import("./extension.ts");
	const { approvedTask, readConfig } = await import("./runner.mjs");
	const repo = fixture(t), dir = join(repo, ".pi-queue"), plan = join(repo, ".tasks/sample");
	mkdirSync(dir); mkdirSync(plan, { recursive: true });
	const config = join(dir, "config.json"), original = { task: "sample", queue: ".tasks/sample/items.md", allowedPaths: ["src"], checks: ["true"], setup: "", parallel: 2, copyFromRepo: ["local.json"], legacyKey: true };
	for (const name of ["brief.md", "rules.md", "items.md", "questions.md"]) writeFileSync(join(plan, name), "");
	saveJson(join(plan, "task.json"), { ...original, status: "queued", queuedAt: "today" });
	saveJson(config, original);
	const before = readFileSync(config, "utf8"), approval = approvedTask(repo, readConfig(repo));
	assert.ok(approval);
	writeFileSync(join(dir, "runner.pid"), `${process.pid}`);
	updateQueueConfig(repo); assert.equal(readFileSync(config, "utf8"), before);
	rmSync(join(dir, "runner.pid")); updateQueueConfig(repo); updateQueueConfig(repo);
	assert.equal(readFileSync(`${config}.bak-unversioned`, "utf8"), before);
	assert.deepEqual(loadJson(config, {}), { ...loadJson(config, {}), ...original, configVersion: 1, workerMode: "rpc" });
	assert.equal(approvedTask(repo, readConfig(repo)), approval);
	assert.equal(readFileSync(join(dir, "log.md"), "utf8").match(/Unrecognized keys retained: legacyKey/g)?.length, 1);
});

test("review: handoff validates the planned itemChecks before running baseline commands", { todo: "A1: handoff validates the old config, not task.itemChecks" }, async (t) => {
	const { handoff } = await import("./extension.ts");
	const repo = fixture(t), dir = join(repo, ".tasks/sample");
	mkdirSync(dir, { recursive: true });
	for (const f of ["brief.md", "rules.md", "questions.md"]) writeFileSync(join(dir, f), "");
	writeFileSync(join(dir, "items.md"), `- [ ] ${item().line}`);
	saveJson(join(dir, "task.json"), { allowedPaths: ["src"], checks: ["false"], itemChecks: { B01: ["true"] } });
	const result = await handoff(repo, "sample", {});
	assert.match(result.text, /A01: missing or invalid focused itemChecks/);
});

test("amend: one item gets exact extra files or new text without editing the plan; its key, dependents and history stay", () => {
	const items = parseQueue("- [ ] O29 — Fix it. Done when: ok. [areas: apps/web/a.ts]\n- [ ] O30 — Use it. Done when: ok. [areas: apps/web/b.ts] [after: O29]");
	const state = { done: {}, failed: { [items[0].key]: "agent: BLOCKED: also needs apps/web/a.test.ts", [items[1].key]: "depends on O29, which failed" }, running: {}, reworks: { [items[0].key]: 2 } };
	assert.deepEqual(applyControl(state, items, { action: "amend", ids: ["O29"], paths: ["apps/web/a.test.ts", ".env"], by: "user" }), ["O29", "O30"]);
	assert.deepEqual(state.scope[items[0].key], ["apps/web/a.test.ts"], ".env is never added");
	assert.equal(state.failed[items[0].key], undefined);
	assert.equal(state.reworks[items[0].key], undefined);
	assert.equal(state.failed[items[1].key], undefined, "the dependent waits again instead of staying failed");
	applyControl(state, items, { action: "amend", ids: ["O29"], line: "Fix it and its test. Done when: ok. [areas: apps/web/a.ts, apps/web/a.test.ts]", by: "user" });
	const now = allItems(items.map((i) => `- [ ] ${i.line}`).join("\n"), state);
	assert.equal(now[0].key, items[0].key);
	assert.match(now[0].line, /^O29 — Fix it and its test/);
	assert.deepEqual(applyControl(state, items, { action: "amend", ids: ["O29"], line: "no done-when here", by: "user" }), [], "an amendment without Done when changes nothing");
});
