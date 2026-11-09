import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseQueue, itemConfig, piTurn, webTurn, applyControl, checksText, checkLine, dependencyGraph, orderQueue, areasOverlap, webClient, deleteSessions } from "./runner.mjs";

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
	assert.match(prompt, /Choose \[model: provider\/id\] and \[thinking: level\] for each item during planning/);
	assert.match(prompt, /rules.md/);
	assert.match(prompt, /separate pi-check budget/);
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
