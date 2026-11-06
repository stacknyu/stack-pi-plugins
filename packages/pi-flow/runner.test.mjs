import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseQueue, itemConfig, piTurn, webTurn, applyControl, checksText, checkLine, dependencyGraph, orderQueue, areasOverlap } from "./runner.mjs";

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
	let created;
	const c = itemConfig(DEFAULTS, item("[model: example/small] [thinking: off]"));
	const web = {
		create: async (body) => { created = body; return { sessionId: "fake" }; },
		send: async () => ({ data: { messages: [{ role: "assistant", content: [{ type: "text", text: "DONE" }], stopReason: "stop" }] } }),
		running: async () => ({ runningSessionIds: [] }),
	};
	const result = await webTurn({ c, web, stopRequested: () => false }, fixture(t), {}, "test", "hello", 1);
	assert.equal(result.status, "ok");
	assert.equal(created.type, "ensure_session", "record the worker identity before sending its prompt");
	assert.equal(created.provider, "example");
	assert.equal(created.modelId, "small");
	assert.equal(created.thinkingLevel, "off");
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
