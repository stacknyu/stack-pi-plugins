import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseQueue, itemConfig, piTurn, webTurn, applyControl, checksText, checkLine, dependencyGraph, orderQueue, areasOverlap, webClient, deleteSessions, main, loadJson, saveJson, notifyRunner, allItems, validateRecovery } from "./runner.mjs";

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
	for (const id of ["A01", "A01a"]) {
		const selected = itemConfig(c, { ...item(), id });
		assert.deepEqual(selected.checks, [...c.checks, ...c.itemChecks.A01]);
		assert.deepEqual(c.checks, ["git diff --check"]);
	}
	for (const id of ["B01", "A01-fix1"]) assert.throws(() => itemConfig(c, { ...item(), id }), /focused itemChecks/);
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
	assert.match(prompt, /separate pi-check budget/);
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
	const items = parseQueue(specs.map((s) => `- [ ] ${s.id} — ${s.id}. Done when: verified. [areas: ${s.area || `out/${s.id}.txt`}] ${s.check ? "[check]" : ""} ${s.after ? `[after: ${s.after}]` : ""}`).join("\n"));
	writeFileSync(join(repo, ".tasks/sample/items.md"), items.map((i) => `- [ ] ${i.line}`).join("\n"));
	const common = `const fs=require('fs'),path=require('path'),home=${JSON.stringify(home)},specs=${JSON.stringify(specs)};
const file=(name)=>path.join(home,name), read=(name)=>fs.existsSync(file(name))?fs.readFileSync(file(name),'utf8'):'';
const count=(key)=>{const n=Number(read(key)||0)+1;fs.writeFileSync(file(key),String(n));return n;};
const event=(kind,id,n,phase)=>fs.appendFileSync(file('events'),JSON.stringify({kind,id,n,phase})+'\\n');
async function barrier(key,hold){const until=Date.now()+20000;while(hold&&!fs.existsSync(file(key))&&!fs.existsSync(file('release-all'))){if(Date.now()>until)throw Error('barrier timed out: '+key);await new Promise(r=>setTimeout(r,10));}}
`;
	const worker = join(home, "worker.cjs"), check = join(home, "check.cjs");
	writeFileSync(worker, `#!/usr/bin/env node\n${common}
(async()=>{const id=process.argv[process.argv.indexOf('-n')+1].match(/queue (\\S+):/)[1],s=specs.find(s=>s.id===id),n=count('worker-'+id),phase=s.check&&n===1?'verification':'coding';
fs.writeFileSync(file(path.basename(process.cwd())+'.owner'),id);fs.writeFileSync(file('prompt-'+id+'-'+n),process.argv.at(-1));event('start',id,n,phase);
if(s.requires&&!fs.existsSync(s.requires))throw Error('dependency not integrated: '+s.requires);
if(n>1&&s.requiresAfterFirst&&!fs.existsSync(s.requiresAfterFirst))throw Error('deferred work retried before integration');
if(!s.check&&/Before you stop, run:|Run the checks, then reply DONE/.test(process.argv.at(-1)))throw Error('mandatory verification leaked into coding prompt');
await barrier('worker-'+id+'-'+n,s.holdWorker===true||(s.holdWorker||[]).includes(n));
const reply=(s.replies||[])[n-1]||'DONE';
if(!s.check&&!s.noChange&&!/BLOCKED|ERROR|WAITING|ALREADY DONE|NEEDS/.test(reply)){fs.mkdirSync('out',{recursive:true});fs.writeFileSync(s.path||'out/'+id+'.txt',id+' turn '+n+'\\n');for(const [p,k] of Object.entries(s.write||{})){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Array.from({length:k},(_,j)=>'line '+j).join('\\n')+'\\n');}}
event('end',id,n,phase);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:reply==='ERROR'?'error':'stop',content:[{type:'text',text:reply}]}}));
})().catch(e=>{console.error(e);process.exitCode=1});\n`, { mode: 0o755 });
	writeFileSync(check, `${common}
(async()=>{const id=read(path.basename(process.cwd())+'.owner');if(!id)return;
const s=specs.find(s=>s.id===id),n=count('check-'+id);event('start',id,n,'check');
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
		const f = schedulerFixture(t, [{ id: "V01", check: true, holdWorker: true }, { id: "V02", check: true }, { id: "A01", holdWorker: true }], { parallel: 1, worktrees });
		const done = f.start();
		await f.wait(() => f.seen("V01", "verification"));
		if (worktrees) await f.wait(() => f.seen("A01", "coding"));
		assert.equal(f.seen("V02", "verification"), false);
		if (!worktrees) assert.equal(f.seen("A01", "coding"), false);
		f.release(); await done;
		assert.equal(Object.keys(f.state().done).length, 3);
		assertPhaseBounds(f.events(), 1);
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
