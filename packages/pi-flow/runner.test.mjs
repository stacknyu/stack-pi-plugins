import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, parseQueue, itemConfig, piTurn, webTurn, applyControl, checksText, checkLine } from "./runner.mjs";

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
});

test("Pi Web worker receives the same resolved pair", async (t) => {
	let created;
	const c = itemConfig(DEFAULTS, item("[model: example/small] [thinking: off]"));
	const web = {
		create: async (body) => { created = body; return { sessionId: "fake" }; },
		send: async (_id, body) => ({ data: { text: body.type === "get_last_assistant_text" ? "DONE" : "" } }),
		running: async () => ({ runningSessionIds: [] }),
	};
	const result = await webTurn({ c, web, stopRequested: () => false }, fixture(t), {}, "test", "hello", 1);
	assert.equal(result.status, "ok");
	assert.equal(created.provider, "example");
	assert.equal(created.modelId, "small");
	assert.equal(created.thinkingLevel, "off");
});

test("unpark honors selected ids", () => {
	const items = parseQueue("- [ ] A01 — first\n- [ ] B01 — second");
	const state = { done: {}, failed: {}, retried: Object.fromEntries(items.map((i) => [i.key, true])) };
	assert.deepEqual(applyControl(state, items, { action: "unpark", ids: ["A01"] }), ["A01"]);
	assert.equal(state.retried[items[1].key], true);
});
