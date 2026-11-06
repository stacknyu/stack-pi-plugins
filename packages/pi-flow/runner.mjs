#!/usr/bin/env node
// pi-flow queue runner. Started in the background by `/queue start` or by the task handoff.
// Usage: node runner.mjs <repo-dir>
//
// Works through every unchecked "- [ ]" line of the queue file, `parallel` items at a time.
// Each item: its own git worktree + a fresh `pi -p` process. The runner (never the agent) checks
// scope, size and the check commands. Passing items are rebased onto the branch, re-checked,
// and fast-forwarded in one at a time. Failed work is kept on queue-failed/<id>.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync, cpSync } from "node:fs";
import { join, isAbsolute, basename, dirname } from "node:path";
import { homedir } from "node:os";

export const DIR = ".pi-queue";

export const DEFAULTS = {
	queue: "", // the work list; set by the task handoff (.tasks/<slug>/items.md)
	task: "", // the task slug this run belongs to
	allowedPaths: [], // the only folders/files items may change
	checks: [], // commands that must pass after every item (verified by /task setup and the handoff)
	readFirst: "AGENTS.md",

	// Parallelism. Each running item gets its own git worktree under .pi-queue/worktrees.
	// The runner adapts the width between parallelMin and parallel: one step down after a conflict,
	// one step up after 3 clean passes in a row. Items whose [areas: …] overlap never run at the same time,
	// and an item waits for the items named in its [after: …] tag.
	worktrees: true,
	parallel: 4,
	parallelMin: 1,
	parallelStart: 0, // 0: start at `parallel`
	adaptive: true,
	setup: "", // install command run once per new worktree, e.g. "pnpm install --frozen-lockfile --prefer-offline"
	setupMinutes: 20,
	copyFromRepo: [], // git-ignored files (e.g. ".env.local") copied into every worktree

	// Size limits per item. An item that needs more says NEEDS: <files> files, <lines> lines and the runner
	// raises its limits to the first level that fits (same session). Past the last level it is split.
	maxNetLines: 150,
	maxFilesGrowing: 5,
	itemMinutes: 40,
	big: { maxNetLines: 600, maxFilesGrowing: 15, itemMinutes: 90 }, // for items tagged [big]
	escalate: [
		{ maxFilesGrowing: 15, maxNetLines: 600, itemMinutes: 90 },
		{ maxFilesGrowing: 40, maxNetLines: 1500, itemMinutes: 120 },
		{ maxFilesGrowing: 200, maxNetLines: 5000, itemMinutes: 150 },
	],
	autoSplit: true, // an item that still cannot be finished is split into smaller items (kept in state.json)
	splitMax: 8,
	redoOnConflict: true, // a conflicting item is redone on the latest code in the same session
	deferBlocked: true, // an item that says BLOCKED while other work is still pending is retried once after that work
	autoFix: true, // a [check] item that reports GAP: lines gets fix items queued before it, then checks again
	gapRounds: 2, // how many fix rounds a [check] item may trigger
	recheck: true, // a passed [check] item runs again when an item it covers ([areas] overlap or [after]) changes later
	fixRounds: 1,
	checkMinutes: 15,
	stopAfterFailuresInARow: 5,

	// Sessions
	model: "", // empty: Pi's default model; or "provider/model-id"
	thinking: "high",
	piCommand: "",
	runIn: "auto", // "auto": items are Pi Web sessions when Pi Web runs, else background `pi`; or "web" / "cli"
	piWebUrl: "", // empty: find the running Pi Web automatically
	// What happens to finished (passed/split) item sessions: "end" deletes them when the run ends, "pass" right after
	// each pass, "archive" archives them in Pi Web (hidden from the sidebar, still searchable), false keeps them.
	// Sessions of failed items are always kept until /task cleanup.
	deleteSessions: "end",
};

// ---------- helpers ----------

export const LOGIN_SHELL = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");

export function run(cwd, file, args, { timeoutMs = 300_000, env } = {}) {
	return new Promise((resolve) => {
		const child = execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
		});
		child.stdin?.end(); // nobody types into these commands: give them an empty stdin, not an open pipe
	});
}
/** Environment for setup and checks. The runner is started from Pi Web (a Node/pnpm process), whose npm_*, PNPM_*,
 *  NODE_ENV, NODE_OPTIONS… would leak into a nested `pnpm` and can make it fail with no useful message. */
const POLLUTED = /^(npm_.*|PNPM_.*|pnpm_.*|INIT_CWD|NODE_ENV|NODE_OPTIONS|NEXT_.*|PORT|HOSTNAME|PI_WEB_.*|FORCE_COLOR|NO_COLOR)$/;
export function cleanEnv() {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) if (!POLLUTED.test(k)) env[k] = v;
	env.CI = "";
	delete env.CI;
	return env;
}
export const git = (cwd, ...args) => run(cwd, "git", args);
export const firstLine = (s) => String(s ?? "").split("\n")[0];
export const tail = (s, n) => String(s ?? "").split("\n").slice(-n).join("\n");

/** The work list plus any items the runner split off, each right after its parent. Parents that were split are left out. */
export function allItems(queueText, state) {
	const out = [];
	const push = (it) => {
		for (const line of state.fixes?.[it.key] ?? []) out.push(...parseQueue(line).map((f) => ({ ...f, child: true, fix: true })));
		const wait = state.waitFor?.[it.key];
		out.push(wait ? { ...it, after: [...new Set([...(it.after ?? []), ...wait])] } : it);
	};
	for (const q of parseQueue(queueText)) {
		const kids = state.splits?.[q.key];
		if (kids) {
			for (const line of kids) for (const k of parseQueue(line)) push({ ...k, child: true });
		} else push(q);
	}
	for (const line of state.added ?? []) for (const a of parseQueue(line)) push({ ...a, added: true });
	return out;
}

/** Changes asked for by you or the manager. Applied by the runner between items, or directly when it is not running. */
export function applyControl(state, items, ctl) {
	const pick = (ids) => {
		const want = (ids ?? []).map((x) => String(x).trim()).filter(Boolean);
		return items.filter((i) => want.length === 0 || want.some((w) => i.id === w || i.id.startsWith(w)));
	};
	const changed = [];
	if (ctl.action === "retry") {
		for (const i of pick(ctl.ids)) {
			if (state.failed[i.key] || state.retried?.[i.key] || state.deferred?.[i.key]) changed.push(i.id);
			delete state.failed[i.key];
			if (state.retried) delete state.retried[i.key];
			if (state.deferred) delete state.deferred[i.key];
		}
	} else if (ctl.action === "recheck" || ctl.action === "rerun") {
		for (const i of pick(ctl.ids)) {
			if (ctl.action === "recheck" && !i.check) continue;
			if (state.done[i.key]) changed.push(i.id);
			delete state.done[i.key];
			delete state.failed[i.key];
		}
	} else if (ctl.action === "unpark") {
		for (const i of pick(ctl.ids)) {
			if (state.retried?.[i.key] || state.deferred?.[i.key]) changed.push(i.id);
			if (state.retried) delete state.retried[i.key];
			if (state.deferred) delete state.deferred[i.key];
		}
	} else if (ctl.action === "next") {
		// run these next: un-park them and put them at the front (dependencies and overlapping areas still apply)
		const keys = pick(ctl.ids).filter((i) => !state.done[i.key]).map((i) => i.key);
		for (const k of keys) {
			delete state.failed[k];
			if (state.retried) delete state.retried[k];
			if (state.deferred) delete state.deferred[k];
		}
		state.priority = [...new Set([...keys, ...(state.priority ?? [])])];
		changed.push(...items.filter((i) => keys.includes(i.key)).map((i) => i.id));
	} else if (ctl.action === "add") {
		const lines = (ctl.lines ?? []).map((l) => (String(l).trim().startsWith("- [ ]") ? String(l).trim() : `- [ ] ${String(l).trim()}`));
		state.added = [...(state.added ?? []), ...lines];
		changed.push(...lines.flatMap((l) => parseQueue(l).map((i) => i.id)));
	}
	return changed;
}

function splitPrompt(c, item, reason) {
	return `This item could not be finished in one go (${firstLine(reason).slice(0, 200)}).

Do NOT edit any file. Split it into 3 to ${c.splitMax} smaller items that together cover everything it requires. Each must be doable on its own by a fresh agent in one session (about 10 files at most), touch a different set of files than the others, and be checkable with the typecheck and build. Order them so each can be done after the ones before it.

Reply with one line per item, in order, each starting with "ITEM: ", then what to do, then "Done when: <something observable>", then the tags [areas: <folders or files it changes, comma separated>] and, only if it needs earlier parts finished first, [after: <their numbers, e.g. 1, 2>]. Parts are numbered from 1 in the order you list them. No other text. If it truly cannot be split, reply with one line: BLOCKED: <reason>`;
}

/** Do two [areas: …] lists touch the same path? (prefix match; globs cut at the first *) */
export function areasOverlap(a, b) {
	const norm = (p) => p.split("*")[0].replace(/\/+$/, "");
	for (const x of a.map(norm))
		for (const y of b.map(norm)) {
			if (!x || !y || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
		}
	return false;
}

/** Per-item limits and session selection; omitted tags inherit the queue defaults. */
export function itemConfig(c, item) {
	const out = { ...c };
	if (c.itemChecks) {
		const checks = c.itemChecks[item.id] ?? c.itemChecks[item.id.match(/^([A-Z]+\d+)[a-z]$/)?.[1]];
		if (!Array.isArray(checks) || checks.some((cmd) => typeof cmd !== "string" || !cmd.trim())) throw new Error(`${item.id}: missing or invalid focused itemChecks`);
		out.checks = [...c.checks, ...checks];
	}
	if (/\[big\]/i.test(item.line)) Object.assign(out, c.big ?? {});
	const tag = item.line.match(/\[((?:files|lines|min)=\d+(?:[\s,]+(?:files|lines|min)=\d+)*)\]/i)?.[1];
	for (const [, k, v] of (tag ?? "").matchAll(/(files|lines|min)=(\d+)/gi)) {
		const key = { files: "maxFilesGrowing", lines: "maxNetLines", min: "itemMinutes" }[k.toLowerCase()];
		out[key] = Number(v);
	}
	for (const key of ["model", "thinking"]) {
		const tags = [...item.line.matchAll(new RegExp(`\\[${key}:\\s*([^\\]]*)\\]`, "gi"))];
		if (tags.length > 1) throw new Error(`${item.id}: duplicate [${key}: …] tags`);
		if (tags.length) {
			const value = tags[0][1].trim();
			if (key === "model" ? !/^[^\s/]+\/\S+$/.test(value) : !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
				throw new Error(`${item.id}: invalid [${key}: ${value}]`);
			}
			out[key] = value;
		}
	}
	return out;
}

export function parseQueue(text) {
	const items = [];
	for (const raw of text.split("\n")) {
		const m = raw.match(/^\s*-\s\[\s\]\s+(.+?)\s*$/);
		if (!m) continue;
		const line = m[1];
		const id = line.match(/^([A-Z]+[0-9]+[A-Za-z0-9-]*)/)?.[1] ?? `item${items.length + 1}`;
		const title = line
			.split(/\s+Done when:/i)[0]
			.replace(/^[A-Z]+[0-9]+[A-Za-z0-9-]*\s*[—:-]\s*/, "")
			.slice(0, 120);
		const tag = (name) =>
			(line.match(new RegExp(`\\[${name}:\\s*([^\\]]+)\\]`, "i"))?.[1] ?? "")
				.split(name === "after" ? /[,\s]+/ : ",")
				.map((x) => x.trim().replace(/^\.\//, "").replace(/`/g, ""))
				.filter(Boolean);
		items.push({
			key: line,
			id,
			title: title.replace(/\s*\[(areas?|after|model|thinking|big|check|files=|lines=|min=)[^\]]*\]/gi, "").trim(),
			line,
			areas: tag("areas?"),
			after: tag("after"),
			check: /\[check\]/i.test(line),
		});
	}
	return items;
}

export function loadJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

export async function ensureDir(cwd) {
	mkdirSync(join(cwd, DIR), { recursive: true });
	const rel = (await git(cwd, "rev-parse", "--git-path", "info/exclude")).out.trim();
	if (!rel) return;
	const exclude = isAbsolute(rel) ? rel : join(cwd, rel);
	try {
		mkdirSync(dirname(exclude), { recursive: true });
		const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		if (!cur.split("\n").includes(`${DIR}/`)) appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${DIR}/\n`);
	} catch {}
}

export function readConfig(cwd) {
	return { ...DEFAULTS, ...loadJson(join(cwd, DIR, "config.json"), {}) };
}

/** Worktrees live inside the repo's ignored .pi-queue/ folder, so Pi Web groups their sessions
 *  with the repo and they inherit the repo's project trust. */
export function worktreeRoot(repo) {
	return join(repo, DIR, "worktrees");
}

function makeLog(repo) {
	return (line) =>
		appendFileSync(join(repo, DIR, "log.md"), `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${line}\n`);
}

/** One-at-a-time lock for integration and ref updates. */
function mutex() {
	let chain = Promise.resolve();
	return (fn) => {
		const next = chain.then(fn, fn);
		chain = next.catch(() => {});
		return next;
	};
}

// ---------- measuring a change against the item's base commit ----------

export async function measure(cwd, base, allowed) {
	const files = new Set();
	let net = 0;
	let growing = 0;
	const inScope = (p) => allowed.some((a) => p.startsWith(a));
	const numstat = await git(cwd, "diff", "--numstat", "--no-renames", base);
	for (const row of numstat.out.split("\n")) {
		const [a, d, p] = row.split("\t");
		if (!p) continue;
		files.add(p);
		const delta = (Number(a) || 0) - (Number(d) || 0);
		if (inScope(p)) {
			net += delta;
			if (delta > 0) growing++;
		}
	}
	const untracked = await git(cwd, "ls-files", "--others", "--exclude-standard", "-z");
	for (const p of untracked.out.split("\0").filter(Boolean)) {
		files.add(p);
		let lines = 0;
		try {
			const t = readFileSync(join(cwd, p), "utf8");
			lines = t ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0;
		} catch {}
		if (inScope(p)) {
			net += lines;
			if (lines > 0) growing++;
		}
	}
	const all = [...files];
	return { files: all, outside: all.filter((p) => !inScope(p)), net, growing };
}

export async function treeIsClean(cwd) {
	const s = await git(cwd, "status", "--porcelain", "--untracked-files=all");
	return s.code === 0 && s.out.trim() === "";
}

// ---------- prompts ----------

function itemPrompt(c, item) {
	if (item.check) return checkPrompt(c, item);
	return `You are doing ONE list item, unattended. Nobody can answer questions. You may be in your own git worktree while other items run in parallel in other worktrees. A script checks your work when you stop; it alone decides whether the work is kept.

ITEM: ${item.line}

Read first: ${c.readFirst}.

Rules (the script enforces the first two and throws away the whole change if broken):
- Change only files under: ${c.allowedPaths.join(", ")}.
- At most ${c.maxNetLines} net added lines and at most ${c.maxFilesGrowing} files that gain lines.
- Make the smallest change that meets the item's "Done when". Reuse existing code. No new abstractions, wrappers, helper layers, generic utilities, or refactors the item does not require.
- Do only this item. Do not fix other items, unrelated warnings or style.
- You may use subagents to read, search and research. Only you edit files.
- Do not ask the user questions. Do not commit. Do not touch git history or branches.
- Before you stop, run: ${checksText(c)}${checkBroker(c) && !c.itemChecks ? "\n- While you work, run tests, type checks and lint with the `check` tool: it runs only what your change affects and reuses results other items already have. Failures it marks pre-existing also fail on the base branch: leave them." : ""}
- If the item clearly needs more than these size limits, do not start editing: reply with exactly one line NEEDS: <files> files, <lines> lines (your honest estimate). The limits are then raised for you.
- If it cannot be done for any other reason (a missing contract, a decision nobody made, scope), undo your edits and reply with exactly one line: BLOCKED: <reason>
- When finished, reply: DONE, then each changed file with one sentence.`;
}

// ---------- size limits: raised automatically, or when the person says so in the session ----------

const UNLIMITED = { maxNetLines: 5000, maxFilesGrowing: 200 };
const SIZE_REASON = /\b(limit|limits|net added|files? gain|five|5 files|150|broader|larger than|too (big|large)|exceed|beyond)\b/i;
const SCOPE_REASON = /\b(outside the (permitted|allowed)|outside (apps|the scope)|frozen|not permitted)\b/i;

/** Did the item stop only because of the size limit? (The runner's own rejection, or an agent BLOCKED about size.) */
function isSizeStop(reason) {
	if (!reason) return false;
	if (/^\d+ net added lines|^\d+ files gain lines|^agent: NEEDS /.test(reason)) return true;
	return reason.startsWith("agent: BLOCKED") && SIZE_REASON.test(reason) && !SCOPE_REASON.test(reason);
}

/** Has the person typed something like "bypass limits" in the item's session? Short messages only (the runner's own prompts are long). */
const BYPASS = /\b(bypass|ignore|lift|remove|raise|disable|drop|skip)\b[^.\n]{0,25}\blimits?\b|\bno (size )?limits?\b/i;
async function bypassAsked(ctx, ref) {
	try {
		let file = ref.file;
		if (!file && ctx.web && ref.id) file = await ctx.web.send(ref.id, { type: "get_state" }).then((r) => r?.data?.sessionFile);
		if (!file) return false;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"user"')) continue;
			const m = JSON.parse(line)?.message;
			if (m?.role !== "user") continue;
			const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p?.text ?? "").join(" ");
			if (text.length < 600 && BYPASS.test(text)) return true;
		}
	} catch {}
	return false;
}

function raisePrompt(c, reason) {
	return `The size limits for this item are now raised to ${c.maxFilesGrowing} files gaining lines and ${c.maxNetLines} net added lines. Previous stop: ${reason}

Do the item now within the raised limits. Keep any edits that are already right. Same other rules: only ${c.allowedPaths.join(", ")}, no questions, no commits. Run the checks, then reply DONE. If it still cannot be done, reply with one line: BLOCKED: <reason>`;
}

function redoPrompt(c, reason) {
	return `Other items were merged into the branch while you worked, and your change no longer fits (${firstLine(reason)}). The worktree has been reset to the latest code.

Do this item again on top of it. Reuse your earlier approach, but first look at what changed in the files you touched. Same rules and limits: only ${c.allowedPaths.join(", ")}, at most ${c.maxNetLines} net added lines, at most ${c.maxFilesGrowing} files gaining lines, no questions, no commits. Run the checks, then reply DONE. If it cannot be done, reply with one line: BLOCKED: <reason>`;
}

function checkPrompt(c, item) {
	return `You are doing ONE CHECK item, unattended. Nobody can answer questions. A script checks your work when you stop.

CHECK: ${item.line}

Read first: ${c.readFirst}.

Verify what the check describes against the current code (read it, run tests/commands that are safe to run).
- You may fix tests, fixtures and docs under ${c.allowedPaths.join(", ")} when they are wrong or missing. Do not change production code.
- If production code does not do what the plan requires, do not fix it. Report each gap on its own line:
  GAP: <what is wrong and what to change, naming the files>. Done when: <observable result>. [areas: <folders/files the fix changes>]
- If everything holds, reply: CHECKED, then one line per thing you verified or fixed.
- If you cannot check it at all (missing environment, credentials, or a decision), reply with exactly one line: BLOCKED: <reason>
- Do not ask questions. Do not commit. Before you stop, run: ${checksText(c)}`;
}

function fixPrompt(c, reason) {
	return `The script rejected the change: ${reason}

Fix only that. Same rules: only ${c.allowedPaths.join(", ")}, at most ${c.maxNetLines} net added lines, at most ${c.maxFilesGrowing} files gaining lines, no new abstractions, no questions, no commits. If it cannot be fixed within the rules, undo your edits and reply with one line: BLOCKED: <reason>`;
}

// ---------- running pi ----------

export async function resolvePi(c) {
	if (c.piCommand) return c.piCommand;
	const r = await run(process.cwd(), LOGIN_SHELL, ["-lc", "command -v pi"]);
	return r.out.trim().split("\n").pop() || "pi";
}

async function loginEnv() {
	const r = await run(process.cwd(), LOGIN_SHELL, ["-lc", 'printf %s "$PATH"']);
	return { ...process.env, PATH: r.out.trim() || process.env.PATH };
}

function describeTool(name, args = {}) {
	const path = args.path ?? args.file_path ?? args.filePath ?? args.file;
	if (name === "bash" && args.command) return `bash: ${String(args.command).replace(/\s+/g, " ").slice(0, 90)}`;
	if (path) return `${name} ${path}`;
	if (args.pattern || args.query) return `${name} "${String(args.pattern ?? args.query).slice(0, 60)}"`;
	return name;
}

function textOf(message) {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content.filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim();
}

/** One `pi --mode json` run. Reports live activity through onActivity(text).
 *  Resolves { status: ok|timeout|stopped|error, reply, err, code }. */
function piTurn(ctx, cwd, sessionId, name, prompt, minutes, onActivity = () => {}) {
	const { c, pi, env, stopRequested } = ctx;
	return new Promise((resolve) => {
		// item sessions live in .pi-queue/sessions: easy to open (/queue open <id>, pi --session <file>) and to delete
		const args = ["--mode", "json", "-a", "--session-dir", join(ctx.repo, DIR, "sessions"), "--session-id", sessionId, "-n", name];
		if (c.model) args.push("--model", c.model);
		if (c.thinking) args.push("--thinking", c.thinking);
		args.push(prompt);
		const child = spawn(pi, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		let raw = "";
		let reply = "";
		let err = "";
		let status = "ok";
		const onRecord = (line) => {
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				raw += `${line}\n`;
				return;
			}
			if (ev.type === "tool_execution_start") onActivity(describeTool(ev.toolName, ev.args));
			else if (ev.type === "tool_execution_end" && ev.isError) onActivity(`${ev.toolName} failed`);
			else if (ev.type === "turn_start") onActivity("thinking");
			else if (ev.type === "compaction_start") onActivity("compacting context");
			else if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const t = textOf(ev.message);
				if (t) reply = t;
			}
		};
		child.stdout.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				if (line.trim()) onRecord(line);
			}
		});
		child.stderr.on("data", (d) => (err += d));
		const kill = (why) => {
			if (status !== "ok") return;
			status = why;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}, 20_000).unref();
		};
		const timer = setTimeout(() => kill("timeout"), minutes * 60_000);
		const poll = setInterval(() => stopRequested() && kill("stopped"), 3_000);
		child.on("error", (e) => {
			status = "error";
			err += String(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearInterval(poll);
			if (buf.trim()) onRecord(buf.trim());
			if (status === "ok" && code !== 0) status = "error";
			resolve({ status, reply: reply || raw.trim(), err: err.trim(), code });
		});
	});
}

// ---------- running an item as a Pi Web session ----------

export function webClient(c) {
	const base = c.piWebUrl.replace(/\/$/, "");
	const password = process.env.PI_WEB_PASSWORD || c.piWebPassword || "";
	const headers = { "content-type": "application/json" };
	if (password) headers.authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
	const call = async (method, path, body, timeoutMs = 60_000) => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = { error: text.slice(0, 300) };
		}
		if (!res.ok || json?.error) throw new Error(`Pi Web ${path}: ${res.status} ${json?.error ?? ""}`.trim());
		return json;
	};
	return {
		available: () => call("GET", "/api/agent/running", undefined, 3000).then(() => true, () => false),
		running: () => call("GET", "/api/agent/running", undefined, 15_000),
		create: (body) => call("POST", "/api/agent/new", body, 300_000),
		send: (id, body) => call("POST", `/api/agent/${encodeURIComponent(id)}`, body, 120_000),
		del: (ids) => call("POST", "/api/sessions/delete", { ids }, 60_000),
		ui: (body) => call("POST", "/api/sessions/ui-state", body, 30_000),
	};
}

/** Finds the running Pi Web: the configured URL, then every server pi-web recorded in
 *  <agentDir>/pi-web-run/*.json, then the default port. */
export async function findPiWeb(c) {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
	const urls = [];
	if (c.piWebUrl) urls.push(c.piWebUrl);
	try {
		const { readdirSync } = await import("node:fs");
		const dir = join(agentDir, "pi-web-run");
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const rec = loadJson(join(dir, f), {});
			if (rec.url) urls.push(rec.url);
			else if (rec.port) urls.push(`http://127.0.0.1:${rec.port}`);
		}
	} catch {}
	urls.push("http://127.0.0.1:30141");
	const reasons = [];
	for (const url of [...new Set(urls.map((u) => u.replace(/\/$/, "")))]) {
		try {
			const headers = {};
			const password = process.env.PI_WEB_PASSWORD || c.piWebPassword || "";
			if (password) headers.authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
			const res = await fetch(`${url}/api/agent/running`, { headers, signal: AbortSignal.timeout(3000) });
			if (res.ok) return { url };
			reasons.push(
				`${url} answered ${res.status}${res.status === 401 ? " (password protected: set PI_WEB_PASSWORD, or piWebPassword in config.json)" : ""}`,
			);
		} catch (e) {
			reasons.push(`${url} not reachable`);
		}
	}
	return { reason: reasons.join("; ") };
}

/** Last tool call in a session file, for the live panel. */
function lastToolCall(sessionFile) {
	try {
		const text = readFileSync(sessionFile, "utf8");
		const lines = text.slice(-200_000).split("\n").reverse();
		for (const line of lines) {
			if (!line.includes('"toolCall"')) continue;
			const entry = JSON.parse(line);
			const content = entry?.message?.content;
			if (!Array.isArray(content)) continue;
			const call = [...content].reverse().find((p) => p?.type === "toolCall");
			if (call) return describeTool(call.name, call.arguments);
		}
	} catch {}
	return undefined;
}

/** One prompt in a Pi Web session (creates the session on the first call).
 *  ref.id holds the Pi Web session id. Resolves like piTurn. */
async function webTurn(ctx, cwd, ref, name, prompt, minutes, onActivity = () => {}) {
	const { c, web, stopRequested } = ctx;
	const deadline = Date.now() + minutes * 60_000;
	const [provider, ...rest] = (c.model || "").split("/");
	const modelId = rest.join("/");
	try {
		if (!ref.id) {
			const r = await web.create({
				cwd,
				type: "prompt",
				message: prompt,
				...(provider && modelId ? { provider, modelId } : {}),
				...(c.thinking ? { thinkingLevel: c.thinking } : {}),
			});
			ref.id = r.sessionId;
			await web.send(ref.id, { type: "set_session_name", name }).catch(() => {});
		} else {
			await web.send(ref.id, { type: "prompt", message: prompt });
		}
	} catch (e) {
		return { status: "error", reply: "", err: String(e?.message ?? e), code: -1 };
	}
	onActivity("thinking");
	let sessionFile;
	let status = "ok";
	let awaitingSince = 0;
	let notRunning = 0;
	let lastSeen = "";
	while (true) {
		await new Promise((r) => setTimeout(r, 3000));
		let snap;
		try {
			snap = await web.running();
		} catch {
			if (Date.now() > deadline) {
				status = "timeout";
				break;
			}
			continue; // Pi Web briefly unreachable: keep waiting until the deadline
		}
		const running = (snap.runningSessionIds ?? []).includes(ref.id);
		const awaiting = (snap.awaitingInputSessionIds ?? []).includes(ref.id);
		if (!running) {
			if (++notRunning >= 2) break;
			continue;
		}
		notRunning = 0;
		if (!sessionFile) {
			sessionFile = await web
				.send(ref.id, { type: "get_state" })
				.then((r) => r?.data?.sessionFile)
				.catch(() => undefined);
			if (sessionFile) ref.file = sessionFile;
		}
		if (sessionFile) {
			const doing = lastToolCall(sessionFile);
			if (doing && doing !== lastSeen) {
				lastSeen = doing;
				onActivity(doing);
			}
		}
		awaitingSince = awaiting ? awaitingSince || Date.now() : 0;
		const why = stopRequested()
			? "stopped"
			: Date.now() > deadline
				? "timeout"
				: awaitingSince && Date.now() - awaitingSince > 120_000
					? "error"
					: "";
		if (why) {
			status = why;
			await web.send(ref.id, { type: "abort" }).catch(() => {});
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 3000));
				const s2 = await web.running().catch(() => null);
				if (s2 && !(s2.runningSessionIds ?? []).includes(ref.id)) break;
			}
			if (why === "error") return { status, reply: "", err: "the agent waited for a person's answer for 2 minutes", code: -1 };
			break;
		}
	}
	const reply = await web
		.send(ref.id, { type: "get_last_assistant_text" })
		.then((r) => r?.data?.text ?? "")
		.catch(() => "");
	return { status, reply: String(reply).trim(), err: "", code: 0 };
}

function problem(repo, text) {
	try {
		writeFileSync(join(repo, DIR, "problem.txt"), `${text}\n`);
	} catch {}
}

/** The baseline failed in a fresh worktree: find out whether the code itself fails, or only the worktree. */
async function diagnose(ctx, wt, failure) {
	const { repo, c } = ctx;
	const cmd = firstLine(failure).replace(/^check failed: /, "").replace(/ \(exit -?\d+\)$/, "");
	const here = await run(repo, LOGIN_SHELL, ["-lc", cmd], { timeoutMs: c.checkMinutes * 60_000, env: cleanEnv() });
	if (here.code !== 0)
		return `The same command also fails in your main folder, so the code itself does not pass it.\nFix that first, or remove the command from "checks" in ${DIR}/config.json.\n\nOutput there:\n${tail(here.out, 25)}`;
	const ig = await git(repo, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory");
	const missing = ig.out
		.split("\n")
		.filter((f) => f && !f.includes("node_modules") && !f.startsWith(`${DIR}/`) && !existsSync(join(wt, f)))
		.slice(0, 20);
	return [
		"The command PASSES in your main folder but FAILS in the fresh worktree.",
		"So something git-ignored is needed that a fresh checkout does not have (build output of another package, generated types, .env files).",
		missing.length ? `Ignored files/folders in your main folder that the worktree lacks:\n  ${missing.join("\n  ")}` : "",
		`Fix: for env files, list them in "copyFromRepo" in ${DIR}/config.json. For build output, add the build to "setup", e.g.`,
		`  "setup": "pnpm install --frozen-lockfile --prefer-offline && pnpm --filter @example/web^... build"`,
	]
		.filter(Boolean)
		.join("\n");
}

// ---------- pi-check (separate plugin, optional) ----------

let brokerInfo;
/** When pi-check is installed, checks go through its shared broker: one run per file content, shared by all
 *  worktrees, throttled, and failures that also fail on the base branch do not fail Go checks. */
export function checkBroker(c) {
	if (c?.checkBroker === false) return undefined;
	if (brokerInfo === undefined) {
		try {
			const info = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-check", "cli.json"), "utf8"));
			brokerInfo = existsSync(info.cli) && existsSync(join(info.shims, "go")) ? info : null;
		} catch {
			brokerInfo = null;
		}
	}
	return brokerInfo || undefined;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function brokerCommand(b, cmd, cwd) {
	const pre = `export PATH=${shq(b.shims)}:"$PATH"; `;
	// go test / go vet: the go shim (per-package results); other commands: the broker runs them whole
	const goOnly = /\bgo\s+(test|vet)\b/.test(cmd) && !/\b(vitest|jest|pytest|tsc|eslint|oxlint|ruff|mypy|pyright|pnpm|npm|yarn|bun|make)\b/.test(cmd);
	return goOnly ? `${pre}${cmd}` : `${pre}${shq(b.node)} ${shq(b.cli)} exec --cwd ${shq(cwd)} -- ${shq(cmd)}`;
}

/** How the item prompt tells the agent to run the checks. A "pi-check" entry means the `check` tool. */
function checksText(c) {
	if (c.itemChecks) {
		const broker = checkBroker(c);
		const lines = c.checks.map((cmd) => {
			const selected = checkLine(c, cmd, ".");
			if (selected.error) throw new Error(selected.error);
			return selected.line;
		});
		return `only these exact selections, from the worktree root (the runner uses the same selections after rebase):\n${lines.join("\n")}\nDo not run generic check/run-changed, --refresh, ./... or full app suites unless explicitly listed for the final verification item. ${broker ? `The shared broker exists at ${broker.cli}; for an additional focused regression use ${shq(broker.node)} ${shq(broker.cli)} exec --cwd "$PWD" -- '<focused command>'.` : ""} A missing shell command named check/pi-check is not a missing broker. Report command exit statuses; no tool-specific RESULT: PASS text is required.`;
	}
	const raw = c.checks.filter((x) => !/^pi-check(\s|$)/.test(x));
	const tool = raw.length !== c.checks.length;
	return [raw.length ? `${raw.map((x) => `(${x})`).join(" && ")} (from the repo root)` : "", tool ? "the `check` tool (it must report RESULT: PASS)" : ""].filter(Boolean).join(", and ");
}

/** The shell line for one check: through pi-check when it is installed. */
export function checkLine(c, raw, cwd) {
	const b = checkBroker(c);
	if (/^pi-check(\s|$)/.test(raw)) {
		// native pi-check run: what this checkout's changes affect; pre-existing failures do not count
		if (!b) return { error: `${raw} — pi-check is not installed (pi install <path to pi-check>), or remove it from "checks"` };
		return { line: `${shq(b.node)} ${shq(b.cli)} ${raw.replace(/^pi-check\s*/, "").trim() || "run"} --cwd ${shq(cwd)}`, factor: 3 };
	}
	// through the broker a check may wait behind other worktrees' runs: allow for that
	return b ? { line: brokerCommand(b, raw, cwd), factor: 3 } : { line: raw, factor: 1 };
}

async function runChecks(c, cwd) {
	for (const cmd of c.checks) {
		const l = checkLine(c, cmd, cwd);
		if (l.error) return `check failed: ${l.error}`;
		const r = await run(cwd, LOGIN_SHELL, ["-lc", l.line], { timeoutMs: c.checkMinutes * 60_000 * l.factor, env: cleanEnv() });
		if (r.code !== 0) return `check failed: ${cmd} (exit ${r.code})\n${tail(r.out, 60)}`;
	}
	return undefined;
}

async function judge(c, cwd, base, reply, item = {}) {
	if (item.check) {
		const gaps = reply.split("\n").filter((l) => /^\s*GAP:\s*\S/.test(l));
		if (gaps.length) return `agent: GAPS ${gaps.length}`;
	}
	const needs = reply.match(/^\s*NEEDS:\s*~?(\d+)\s*files?\D+?~?(\d+)\s*lines?/im);
	if (needs) return `agent: NEEDS ${needs[1]} files, ${needs[2]} lines`;
	const blocked = reply.match(/^\s*BLOCKED:\s*(.+)$/m);
	if (blocked) return `agent: BLOCKED: ${blocked[1].slice(0, 300)}`;
	const m = await measure(cwd, base, c.allowedPaths);
	if (m.files.length === 0) return item.check ? runChecks(c, cwd) : "no changes were made";
	if (m.outside.length) return `files outside ${c.allowedPaths.join(", ")}: ${m.outside.slice(0, 8).join(", ")}`;
	if (m.net > c.maxNetLines) return `${m.net} net added lines (limit ${c.maxNetLines})`;
	if (m.growing > c.maxFilesGrowing) return `${m.growing} files gain lines (limit ${c.maxFilesGrowing})`;
	return runChecks(c, cwd);
}

// ---------- worktrees ----------

async function prepareWorktree(ctx, slot) {
	const { repo, c, log } = ctx;
	const wt = join(worktreeRoot(repo), `w${slot}`);
	const ready = `${wt}.ready`;
	if (!existsSync(join(wt, ".git"))) {
		mkdirSync(worktreeRoot(repo), { recursive: true });
		await git(repo, "worktree", "prune");
		const add = await git(repo, "worktree", "add", "--detach", wt, ctx.branch);
		if (add.code !== 0) throw new Error(`git worktree add failed: ${tail(add.out, 5)}`);
		rmSync(ready, { force: true });
	}
	await git(wt, "checkout", "--detach", "--force", (await git(repo, "rev-parse", ctx.branch)).out.trim());
	await git(wt, "clean", "-fd");
	for (const rel of c.copyFromRepo ?? []) {
		try {
			if (existsSync(join(repo, rel))) cpSync(join(repo, rel), join(wt, rel), { recursive: true, force: true });
		} catch {}
	}
	if (!existsSync(ready) && c.setup) {
		log(`SETUP w${slot}: ${c.setup}`);
		ctx.state.phase = `installing dependencies in worktree w${slot}`;
		ctx.save();
		const r = await run(wt, LOGIN_SHELL, ["-lc", c.setup], { timeoutMs: c.setupMinutes * 60_000, env: cleanEnv() });
		if (r.code !== 0) {
			problem(repo, `setup failed in worktree w${slot}\ncommand: ${c.setup}\n\n${tail(r.out, 60)}`);
			throw new Error(`setup failed (${firstLine(tail(r.out, 1))}) — full output in ${DIR}/problem.txt`);
		}
	}
	writeFileSync(ready, "");
	return wt;
}

// ---------- sessions ----------

/** Session files of terminal-mode items (.pi-queue/sessions/**), by session id. */
export function sessionFiles(repo, ids) {
	const root = join(repo, DIR, "sessions");
	const want = new Set(ids);
	const found = {};
	const walk = (dir, depth) => {
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && depth < 3) walk(join(dir, e.name), depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) for (const id of want) if (e.name.includes(id)) found[id] = join(dir, e.name);
		}
	};
	walk(root, 0);
	return found;
}

/** Remove (or archive) item sessions: Pi Web sessions through its API, terminal ones by deleting their files.
 *  Pi Web never deletes a running session. Marks them in state. Returns how many went. */
export async function deleteSessions(ctx, ids, mode = "delete") {
	const sessions = ctx.state.sessions ?? {};
	const webIds = ids.filter((id) => sessions[id]?.web);
	const cliIds = ids.filter((id) => sessions[id] && !sessions[id].web);
	let n = 0;
	if (webIds.length && ctx.web) {
		try {
			if (mode === "archive") {
				await ctx.web.ui({ action: "set", ids: webIds, archived: true });
				for (const id of webIds) sessions[id].archived = true;
				n += webIds.length;
			} else {
				const r = await ctx.web.del(webIds);
				for (const id of [...(r.deleted ?? []), ...(r.missing ?? [])]) if (sessions[id]) sessions[id].deleted = true;
				n += (r.deleted ?? []).filter((id) => webIds.includes(id)).length;
			}
		} catch (e) {
			ctx.log(`CLEANUP failed: ${e?.message ?? e}`);
		}
	}
	if (cliIds.length && mode !== "archive") {
		const files = sessionFiles(ctx.repo, cliIds);
		for (const id of cliIds) {
			try {
				if (files[id]) rmSync(files[id], { force: true });
				sessions[id].deleted = true;
				if (files[id]) n++;
			} catch {}
		}
	}
	ctx.save();
	return n;
}

// ---------- one item ----------

async function workItem(ctx, slot, wt, item) {
	const { repo, state, save, log, lock, branch } = ctx;
	const itemChecks = loadJson(join(repo, ".tasks", ctx.c.task, "task.json"), {}).itemChecks;
	let c = itemConfig({ ...ctx.c, itemChecks }, item); // keep worker, judge and rebase checks identical
	const started = Date.now();
	const solo = wt === repo; // working directly in the repo folder
	let base = (await git(repo, "rev-parse", branch)).out.trim();
	if (solo) await git(wt, "reset", "--hard", base);
	else await git(wt, "checkout", "--detach", "--force", base);
	await git(wt, "clean", "-fd");

	const cliId = `queue-${item.id}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`.replace(/[^A-Za-z0-9._-]/g, "-");
	const ref = { id: ctx.web ? undefined : cliId };
	const turn = (prompt, minutes, onAct) =>
		ctx.web ? webTurn({ ...ctx, c }, wt, ref, name, prompt, minutes, onAct) : piTurn({ ...ctx, c }, wt, cliId, name, prompt, minutes, onAct);
	const sessionId = cliId;
	const name = `queue ${item.id}: ${item.title}`.slice(0, 80);
	const live = { id: item.id, title: item.title, model: c.model, thinking: c.thinking, sessionId, worktree: wt, startedAt: new Date().toISOString(), doing: "starting", tools: 0, since: Date.now() };
	state.running[slot] = live;
	save();
	mkdirSync(join(repo, DIR, "live"), { recursive: true });
	const liveLog = join(repo, DIR, "live", `${item.id}.log`);
	let lastSave = 0;
	const setDoing = (what, isTool = false) => {
		if (ref.id && live.sessionId !== ref.id) live.sessionId = ref.id;
		live.doing = what;
		live.since = Date.now();
		if (isTool) live.tools++;
		try {
			appendFileSync(liveLog, `${new Date().toISOString().slice(11, 19)} ${what}\n`);
		} catch {}
		if (Date.now() - lastSave > 2000) {
			lastSave = Date.now();
			save();
		}
	};
	const onActivity = (what) => setDoing(what, what !== "thinking" && what !== "compacting context" && !what.endsWith(" failed"));

	let t = await turn(itemPrompt(c, item), c.itemMinutes, onActivity);
	if (ref.id) {
		state.sessions = { ...(state.sessions ?? {}), [ref.id]: { item: item.id, status: "running", web: !!ctx.web } };
		save();
	}
	let redone = false;
	let bypassed = false;
	const raise = (why, limits) => {
		c = { ...c, ...limits };
		log(`LIMITS RAISED ${item.id} · ${why} · now ${c.maxFilesGrowing} files / ${c.maxNetLines} lines`);
	};
	const verdict = async () => {
		if (t.status === "stopped") return "stopped by request";
		if (t.status === "timeout") return `timed out after ${c.itemMinutes} min`;
		if (t.status === "error") return `pi exited with an error (code ${t.code}): ${firstLine(t.err || t.reply).slice(0, 200)}`;
		if (!bypassed && (await bypassAsked(ctx, ref))) {
			bypassed = true;
			raise("you asked for it in the session", UNLIMITED);
		}
		setDoing("runner: checking scope, size and checks");
		save();
		return judge(c, wt, base, t.reply, item);
	};
	let reason = await verdict();
	// stopped only because of the size limit: raise it a level and let the same agent carry on in the same session
	for (const level of ctx.c.escalate ?? []) {
		if (!reason || t.status !== "ok" || !isSizeStop(reason) || ctx.stopRequested()) break;
		if (level.maxNetLines <= c.maxNetLines && level.maxFilesGrowing <= c.maxFilesGrowing) continue; // already past this level
		const need = reason.match(/^agent: NEEDS (\d+) files, (\d+) lines/);
		if (need && (level.maxFilesGrowing < Number(need[1]) || level.maxNetLines < Number(need[2]))) continue; // too small for the estimate
		raise(firstLine(reason).slice(0, 100), level);
		setDoing("continuing with raised limits");
		t = await turn(raisePrompt(c, reason), Math.max(c.itemMinutes, level.itemMinutes ?? 90), onActivity);
		reason = await verdict();
	}
	for (let round = 0; reason && t.status === "ok" && round < c.fixRounds; round++) {
		if (reason.startsWith("agent: BLOCKED") || reason.startsWith("agent: GAPS") || reason === "no changes were made" || ctx.stopRequested()) break;
		setDoing(`fixing: ${firstLine(reason).slice(0, 80)}`);
		t = await turn(fixPrompt(c, reason), Math.max(10, Math.round(c.itemMinutes / 2)), onActivity);
		reason = await verdict();
	}

	let kind = reason ? "fail" : "pass";
	let splitLines = [];
	let fixLines = [];
	const sessionTags = `${c.model ? ` [model: ${c.model}]` : ""}${c.thinking ? ` [thinking: ${c.thinking}]` : ""}`;
	// a check found production gaps: queue fix items before it and check again after them
	if (reason?.startsWith("agent: GAPS") && item.check) {
		const round = (state.gapRound?.[item.key] ?? 0) + 1;
		const gaps = t.reply.split("\n").map((l) => l.match(/^\s*GAP:\s*(.+?)\s*$/)?.[1]).filter(Boolean).slice(0, 8);
		if (c.autoFix !== false && round <= (c.gapRounds ?? 2)) {
			const base0 = (state.fixes?.[item.key] ?? []).length;
			fixLines = gaps.map((g, i) => `- [ ] ${item.id}-fix${base0 + i + 1} — ${/Done when:/i.test(g) ? g : `${g}. Done when: ${item.id} can verify it.`}${sessionTags}`);
			kind = "gaps";
			state.gapRound = { ...(state.gapRound ?? {}), [item.key]: round };
		} else reason = `gaps remain after ${round - 1} fix round(s): ${gaps.map((g) => g.slice(0, 120)).join(" | ")}`;
	}
	// BLOCKED while other work is still pending (often a prerequisite that has not run yet): try once more after it
	const blockedOnly = reason?.startsWith("agent: BLOCKED") && !isSizeStop(reason) && !SCOPE_REASON.test(reason);
	if (kind === "fail" && blockedOnly && c.deferBlocked !== false && !state.deferred?.[item.key] && ctx.otherWorkPending?.(item)) kind = "deferred";
	if (kind === "fail" && reason && c.autoSplit !== false && !item.child && t.status === "ok" && !ctx.stopRequested() && (reason.startsWith("agent: BLOCKED") || isSizeStop(reason)) && !SCOPE_REASON.test(reason)) {
		setDoing("asking the agent to split this item");
		save();
		const st = await turn(splitPrompt(c, item, reason), 15, onActivity);
		const texts = String(st.reply)
			.split("\n")
			.map((l) => l.match(/^\s*ITEM:\s*(.+?)\s*$/)?.[1])
			.filter(Boolean)
			.slice(0, c.splitMax ?? 8);
		if (st.status === "ok" && texts.length >= 2) {
			const kid = (n) => `${item.id}${String.fromCharCode(96 + n)}`;
			splitLines = texts.map(
				(txt, i) =>
					`- [ ] ${kid(i + 1)} — ${txt.replace(/\[after:\s*([^\]]+)\]/i, (_, deps) => `[after: ${deps.split(/[,\s]+/).filter(Boolean).map((d) => (/^\d+$/.test(d) ? kid(Number(d)) : d)).join(", ")}]`)}${sessionTags}`,
			);
			kind = "split";
		}
	}
	let sha = "";
	let m;
	for (let attempt = 0; !reason && attempt < 2; attempt++) {
		m = await measure(wt, base, c.allowedPaths);
		if (m.files.length === 0) {
			sha = "checked"; // a [check] item that verified without changing anything: nothing to commit
			break;
		}
		await git(wt, "add", "-A");
		await git(wt, "reset", "--soft", base);
		const commit = await git(wt, "commit", "-m", `${item.id}: ${item.title}`);
		if (commit.code !== 0) {
			reason = `commit failed: ${tail(commit.out, 5).replace(/\n/g, " ")}`;
			kind = "fail";
		} else {
			// integrate one at a time: rebase onto the branch tip, re-check if it moved, fast-forward
			setDoing("waiting to merge");
			save();
			const r = solo
				? { sha: (await git(repo, "rev-parse", "--short", "HEAD")).out.trim() } // already committed on the branch
				: await lock(async () => {
				setDoing("merging into the branch");
				save();
				const tip = (await git(repo, "rev-parse", branch)).out.trim();
				if (tip !== base) {
					const rb = await git(wt, "rebase", tip);
					if (rb.code !== 0) {
						await git(wt, "rebase", "--abort");
						return { reason: "conflict with an item merged meanwhile", kind: "conflict" };
					}
					const broke = await runChecks(c, wt);
					if (broke) return { reason: `breaks checks after merging with other items: ${firstLine(broke)}`, kind: "conflict" };
				}
				const head = (await git(wt, "rev-parse", "HEAD")).out.trim();
				const ff = await git(repo, "merge", "--ff-only", head);
				if (ff.code !== 0) return { reason: `could not fast-forward ${branch}: ${tail(ff.out, 3).replace(/\n/g, " ")}`, kind: "fail" };
				return { sha: (await git(repo, "rev-parse", "--short", "HEAD")).out.trim() };
			});
			if (r.sha) sha = r.sha;
			else {
				reason = r.reason;
				kind = r.kind;
			}
		}
		// the branch moved and this change no longer fits: redo it on the latest code in the same session (once),
		// instead of throwing the work away and starting from scratch at the end
		if (reason && kind === "conflict" && attempt === 0 && c.redoOnConflict !== false && !solo && !ctx.stopRequested()) {
			setDoing("redoing the item on the latest code");
			await git(repo, "branch", "-f", `queue-failed/${item.id}`, (await git(wt, "rev-parse", "HEAD")).out.trim());
			base = (await git(repo, "rev-parse", branch)).out.trim();
			await git(wt, "checkout", "--detach", "--force", base);
			await git(wt, "clean", "-fd");
			redone = true;
			log(`REDO ${item.id} · ${firstLine(reason)} · same session, on the latest code`);
			t = await turn(redoPrompt(c, reason), c.itemMinutes, onActivity);
			reason = await verdict();
			kind = reason ? "fail" : "pass";
			continue;
		}
		break;
	}

	const mins = Math.round((Date.now() - started) / 60_000);
	mkdirSync(join(repo, DIR, "notes"), { recursive: true });
	writeFileSync(
		join(repo, DIR, "notes", `${item.id}.md`),
		`# ${item.line}\n\nResult: ${reason ? `${kind.toUpperCase()} — ${reason}` : `PASS ${sha}`}\nSession: ${ref.id ?? sessionId}${ctx.web ? " (Pi Web)" : ""}\nWorktree: ${wt}\n\n## Agent's last reply\n\n${t.reply}\n${t.err ? `\n## stderr\n\n${t.err.slice(-4000)}\n` : ""}`,
	);

	let kept = "";
	if (reason) {
		await lock(async () => {
			await git(wt, "add", "-A");
			const hasWork = (await git(wt, "rev-parse", "HEAD")).out.trim() !== base || !(await treeIsClean(wt));
			if (hasWork) {
				await git(wt, "commit", "--no-verify", "--allow-empty", "-m", `queue FAILED ${item.id}: ${firstLine(reason)}`);
				await git(repo, "branch", "-f", `queue-failed/${item.id}`, (await git(wt, "rev-parse", "HEAD")).out.trim());
				kept = ` · work kept on queue-failed/${item.id}`;
			}
		});
	}
	if (solo) await git(wt, "reset", "--hard", reason ? base : "HEAD");
	else await git(wt, "checkout", "--detach", "--force", (await git(repo, "rev-parse", branch)).out.trim());
	await git(wt, "clean", "-fd");
	delete state.running[slot];

	if (!reason) {
		state.done[item.key] = sha;
		delete state.failed[item.key];
		await lock(() => git(repo, "branch", "-D", `queue-failed/${item.id}`)); // stale archive from an earlier attempt
		log(sha === "checked" ? `PASS ${item.id} · checked, nothing to change · ${mins} min · w${slot}` : `PASS ${item.id} · ${sha} · ${m.files.length} files · net ${m.net} lines · ${mins} min · w${slot}`);
	} else if (kind === "gaps") {
		state.fixes = { ...(state.fixes ?? {}), [item.key]: [...(state.fixes?.[item.key] ?? []), ...fixLines] };
		const ids = fixLines.flatMap((l) => parseQueue(l).map((i) => i.id));
		state.waitFor = { ...(state.waitFor ?? {}), [item.key]: [...new Set([...(state.waitFor?.[item.key] ?? []), ...ids])] };
		delete state.failed[item.key];
		log(`GAPS ${item.id} · found ${ids.length} production gap(s) → queued ${ids.join(", ")} · ${item.id} checks again after them · ${mins} min`);
	} else if (kind === "deferred") {
		state.deferred = { ...(state.deferred ?? {}), [item.key]: true };
		delete state.failed[item.key];
		log(`DEFERRED ${item.id} · ${firstLine(reason).slice(0, 140)} · will try again once the other pending items are done · ${mins} min`);
	} else if (kind === "split") {
		state.splits = { ...(state.splits ?? {}), [item.key]: splitLines };
		delete state.failed[item.key];
		log(`SPLIT ${item.id} · could not be done in one go (${firstLine(reason).slice(0, 80)}) · now ${splitLines.length} smaller items ${item.id}a…${item.id}${String.fromCharCode(96 + splitLines.length)}${kept}`);
	} else if (kind === "conflict" && !state.retried[item.key]) {
		state.retried[item.key] = true;
		log(`CONFLICT ${item.id} · ${firstLine(reason)}${kept} · will retry at the end · ${mins} min`);
	} else if (reason !== "stopped by request") {
		state.failed[item.key] = firstLine(reason);
		log(`FAIL ${item.id} · ${firstLine(reason)}${kept} · ${mins} min · w${slot}`);
	} else {
		log(`STOPPED ${item.id}${kept}`);
	}
	if (ref.id && state.sessions?.[ref.id]) {
		state.sessions[ref.id].status = !reason ? "pass" : ["split", "gaps", "deferred"].includes(kind) ? kind : reason === "stopped by request" ? "stopped" : "fail";
		if (!reason && ctx.c.deleteSessions === "pass") await deleteSessions(ctx, [ref.id]);
	}
	save();
	return { pass: !reason, kind, redone, stopped: reason === "stopped by request" };
}

// ---------- the scheduler ----------

export async function main(repo) {
	await ensureDir(repo);
	const log = makeLog(repo);
	const pidFile = join(repo, DIR, "runner.pid");
	writeFileSync(pidFile, String(process.pid));
	process.on("exit", () => {
		try {
			if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile, { force: true });
		} catch {}
	});
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(1));

	const c = readConfig(repo);
	const statePath = join(repo, DIR, "state.json");
	const state = { done: {}, failed: {}, retried: {}, ...loadJson(statePath, {}), running: {}, phase: "starting" };
	const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	save();
	rmSync(join(repo, DIR, "STOP"), { force: true });
	rmSync(join(repo, DIR, "problem.txt"), { force: true });
	rmSync(join(repo, DIR, "PAUSE"), { force: true });
	const stopRequested = () => existsSync(join(repo, DIR, "STOP"));
	const pauseRequested = () => existsSync(join(repo, DIR, "PAUSE"));

	const branch = (await git(repo, "branch", "--show-current")).out.trim();
	if (!branch) return log("NOT STARTED: the repo is on a detached HEAD; check out a branch first");
	if (!(await treeIsClean(repo))) return log("NOT STARTED: working tree is not clean (commit or stash first)");
	const queuePath = join(repo, c.queue);
	if (!c.queue) return log("NOT STARTED: no work list set (run /task to plan one, or set \"queue\" in .pi-queue/config.json)");
	if (!existsSync(queuePath)) return log(`NOT STARTED: queue file ${c.queue} not found`);

	const ctx = { repo, c, state, save, log, lock: mutex(), branch, stopRequested, pi: await resolvePi(c), env: await loginEnv(), web: null };
	if (c.runIn !== "cli") {
		const found = await findPiWeb(c);
		if (found.url) {
			c.piWebUrl = found.url;
			ctx.web = webClient(c);
		} else if (c.runIn === "web") return log(`NOT STARTED: Pi Web not usable: ${found.reason}`);
		else log(`Pi Web not usable (${found.reason}); items run as background pi instead`);
	}
	const parallel = c.worktrees ? Math.max(1, Math.floor(c.parallel) || 1) : 1;
	log(`START · branch ${branch} · ${c.worktrees ? `up to ${parallel} parallel (worktrees${c.adaptive !== false ? ", adaptive" : ""})` : "one at a time in your repo folder"} · ${c.model || "default model"} @ ${c.thinking || "default"} · ${ctx.web ? `items run as Pi Web sessions (${c.piWebUrl})` : `items run as background pi (${ctx.pi})`}`);

	// worktrees are made when a slot is first used; w0 now, for the baseline check
	let maxW = c.worktrees ? Math.max(1, Math.floor(c.parallel) || 1) : 1;
	const minW = Math.min(maxW, Math.max(1, Math.floor(c.parallelMin) || 1));
	let width = Math.min(maxW, Math.max(minW, Math.floor(c.parallelStart) || maxW));
	const wts = [];
	const prepLock = mutex();
	try {
		wts[0] = c.worktrees ? await prepareWorktree(ctx, 0) : repo;
	} catch (e) {
		return log(`NOT STARTED: ${e.message}`);
	}
	if (checkBroker(c)) log("CHECKS via pi-check · shared across worktrees, cached by file content, pre-existing Go failures do not block");
	state.phase = "checking the unchanged code (baseline)";
	save();
	const baseline = await runChecks(c, wts[0]);
	state.phase = "running items";
	state.width = width;
	save();
	if (baseline) {
		state.phase = "diagnosing the failed baseline";
		save();
		const why = await diagnose(ctx, wts[0], baseline);
		problem(repo, `checks fail before any change (worktree w0)\n\n${baseline}\n\n--- diagnosis ---\n${why}`);
		state.phase = "";
		save();
		return log(`NOT STARTED: ${firstLine(baseline)} — the checks already fail before any change. Full output and diagnosis: ${DIR}/problem.txt`);
	}

	const inFlight = new Map(); // key -> item
	const nextItem = () => {
		let items = [];
		try {
			items = allItems(readFileSync(queuePath, "utf8"), state); // re-read: items can be added while running
		} catch {}
		const byId = new Map(items.map((i) => [i.id, i]));
		const finished = (i) => state.done[i.key] || state.failed[i.key];
		// a split parent counts as done when all its parts are done
		const depState = (id) => {
			if (id === "*") return "wildcard";
			const i = byId.get(id);
			if (i) return state.done[i.key] ? "done" : state.failed[i.key] ? "failed" : "open";
			const kids = items.filter((k) => k.child && k.id.startsWith(id) && /^[a-z]$/.test(k.id.slice(id.length)));
			if (kids.length) return kids.every((k) => state.done[k.key]) ? "done" : kids.some((k) => state.failed[k.key]) ? "failed" : "open";
			return "unknown"; // a typo or an id from elsewhere: ignored
		};
		const open = items.filter((i) => !finished(i) && !inFlight.has(i.key));
		const parked = (i) => state.retried[i.key] || state.deferred?.[i.key];
		const prio = state.priority ?? [];
		const rank = (i) => (prio.includes(i.key) ? prio.indexOf(i.key) : prio.length);
		const ordered = [...open.filter((i) => !parked(i)), ...(inFlight.size === 0 ? open.filter(parked) : [])].sort((a, b) => rank(a) - rank(b));
		for (const i of ordered) {
			let wait = false;
			for (const d of i.after ?? []) {
				const st = depState(d);
				if (st === "failed") {
					state.failed[i.key] = `depends on ${d}, which failed`;
					log(`FAIL ${i.id} · depends on ${d}, which failed · not started`);
					save();
					wait = true;
					break;
				}
				if (st === "open") wait = true;
				if (st === "wildcard" && (items.some((o) => o !== i && !finished(o) && !(o.after ?? []).includes("*")) || inFlight.size)) wait = true;
			}
			if (wait) continue;
			if (i.areas?.length && [...inFlight.values()].some((r) => r.areas?.length && areasOverlap(i.areas, r.areas))) continue;
			return i;
		}
		return undefined;
	};

	ctx.otherWorkPending = (item) => {
		try {
			const items = allItems(readFileSync(queuePath, "utf8"), state);
			return items.some((i) => i.key !== item.key && !state.done[i.key] && !state.failed[i.key] && !state.deferred?.[i.key]) || [...inFlight.keys()].some((k) => k !== item.key);
		} catch {
			return false;
		}
	};
	const controlFile = join(repo, DIR, "control.json");
	const readControl = () => {
		if (!existsSync(controlFile)) return;
		let list = [];
		try {
			list = JSON.parse(readFileSync(controlFile, "utf8"));
		} catch {}
		rmSync(controlFile, { force: true });
		const items = (() => {
			try {
				return allItems(readFileSync(queuePath, "utf8"), state);
			} catch {
				return [];
			}
		})();
		for (const ctl of Array.isArray(list) ? list : [list]) {
			if (ctl?.action === "parallel") {
				const n = Math.max(1, Math.floor(Number(ctl.value)) || 1);
				if (!c.worktrees) {
					log("CONTROL parallel ignored: this run works in the repo folder (worktrees: false)");
					continue;
				}
				while (slots < n) free.push(slots++);
				maxW = n; // your number is the ceiling; adaptive narrowing still applies below it
				setWidth(n, "asked by you");
				try {
					const cf = join(repo, DIR, "config.json");
					writeFileSync(cf, `${JSON.stringify({ ...loadJson(cf, {}), parallel: n }, null, 2)}\n`);
				} catch {}
				continue;
			}
			const changed = applyControl(state, items, ctl ?? {});
			log(`CONTROL ${ctl?.action} ${(ctl?.ids ?? []).join(",") || (ctl?.action === "add" ? "" : "all")} · ${changed.length ? changed.join(", ") : "nothing matched"}${ctl?.by ? ` · by ${ctl.by}` : ""}`);
		}
		save();
	};
	// a passed [check] runs again when an item it covers changes after it
	const recheckAfter = (passed) => {
		if (c.recheck === false || passed.check) return;
		let items = [];
		try {
			items = allItems(readFileSync(queuePath, "utf8"), state);
		} catch {}
		for (const chk of items) {
			if (!chk.check || !state.done[chk.key] || chk.key === passed.key) continue;
			const covers = (chk.after ?? []).includes(passed.id) || (chk.after ?? []).includes("*") || (chk.areas?.length && passed.areas?.length && areasOverlap(chk.areas, passed.areas));
			if (!covers) continue;
			delete state.done[chk.key];
			log(`RECHECK ${chk.id} · ${passed.id} changed what it checks · queued again`);
		}
		save();
	};

	let failsInARow = 0;
	let cleanStreak = 0;
	let halted = "";
	const free = Array.from({ length: maxW }, (_, i) => i);
	let slots = maxW; // worktree slots created so far
	const running = new Map();
	const setWidth = (w, why) => {
		if (w === width) return;
		log(`WIDTH ${width} → ${w} · ${why}`);
		width = w;
		state.width = w;
		save();
	};
	while (true) {
		readControl();
		while (!halted && running.size < width && free.length && !stopRequested() && !pauseRequested()) {
			free.sort((a, b) => a - b);
			if (free[0] >= maxW) break; // slots above a lowered ceiling stay idle
			const item = nextItem();
			if (!item) break;
			free.sort((a, b) => a - b);
			const slot = free.shift();
			inFlight.set(item.key, item);
			const p = (async () => {
				if (!wts[slot]) {
					wts[slot] = await prepLock(() => prepareWorktree(ctx, slot));
				}
				return workItem(ctx, slot, wts[slot], item);
			})()
				.catch((e) => {
					log(`ERROR ${item.id} · ${e?.message ?? e}`);
					return { pass: false, kind: "fail" };
				})
				.then((r) => ({ r, slot, item }));
			running.set(slot, p);
		}
		if (running.size === 0) {
			readControl();
			if (!halted && !stopRequested() && !pauseRequested() && nextItem()) continue; // the manager queued more work
			break;
		}
		// wake every few seconds to apply control requests while items run
		const done = await Promise.race([...running.values(), new Promise((res) => setTimeout(() => res(null), 5000))]);
		if (!done) continue;
		const { r, slot, item } = done;
		running.delete(slot);
		free.push(slot);
		inFlight.delete(item.key);
		if (r.pass) {
			failsInARow = 0;
			recheckAfter(item);
		} else if (r.kind === "fail") failsInARow++;
		if (c.adaptive !== false && c.worktrees) {
			if (r.redone || r.kind === "conflict") {
				cleanStreak = 0;
				setWidth(Math.max(minW, width - 1), `${item.id} conflicted with other work`);
			} else if (r.pass && ++cleanStreak >= 3) {
				cleanStreak = 0;
				setWidth(Math.min(maxW, width + 1), "3 clean passes in a row");
			}
		}
		if (!halted && failsInARow >= c.stopAfterFailuresInARow) {
			halted = `${failsInARow} failures in a row`;
			log(`STOPPING: ${halted} (running items finish first)`);
		}
		if (stopRequested() && !halted) halted = "stop requested";
		if (pauseRequested() && !halted) halted = "paused after running items finished";
	}
	if (pauseRequested() && !halted) halted = "paused after running items finished";
	state.phase = halted || "finished";
	save();
	const left = allItems(readFileSync(queuePath, "utf8"), state).filter((i) => !state.done[i.key] && !state.failed[i.key]).length;
	log(`END · passed ${Object.keys(state.done).length} · failed ${Object.keys(state.failed).length} · still open ${left}${halted ? ` · ${halted}` : ""}`);
	if (c.deleteSessions && c.deleteSessions !== "pass" && !halted) {
		const ids = Object.entries(state.sessions ?? {})
			.filter(([, x]) => !x.deleted && !x.archived && (x.status === "pass" || x.status === "split"))
			.map(([id]) => id);
		const mode = c.deleteSessions === "archive" ? "archive" : "delete";
		const n = await deleteSessions(ctx, ids, mode);
		if (n) log(`CLEANUP · ${mode === "archive" ? "archived" : "removed"} ${n} finished item sessions (sessions of failed items are kept; /task cleanup removes the rest)`);
	}
}

export { piTurn, webTurn, checksText };

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const repo = process.argv[2] || process.cwd();
	main(repo).catch((e) => {
		try {
			makeLog(repo)(`CRASH ${e?.stack ?? e}`);
		} catch {}
		process.exit(1);
	});
}
