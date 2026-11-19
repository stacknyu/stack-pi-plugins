#!/usr/bin/env node
// pi-flow queue runner. Started in the background by `/queue start` or by the task handoff.
// Usage: node runner.mjs <repo-dir>
//
// Works through every unchecked "- [ ]" line of the queue file, `parallel` items at a time.
// Each item: its own git worktree + a fresh `pi -p` process. The runner (never the agent) checks
// scope, size and the check commands. Passing items are rebased onto the branch, re-checked,
// and fast-forwarded in one at a time. Failed work is kept on queue-failed/<id>.
import { spawn, execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync, cpSync, openSync, closeSync, renameSync, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join, isAbsolute, basename, dirname, posix } from "node:path";
import { totalmem, freemem, homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export const DIR = ".pi-queue";

export const DEFAULTS = {
	configVersion: 1, // on-disk schema, not part of task approval
	queue: "", // the work list; set by the task handoff (.tasks/<slug>/items.md)
	task: "", // the task slug this run belongs to
	allowedPaths: [], // the only folders/files items may change
	checks: [], // commands that must pass after every item (verified by /task setup and the handoff)
	readFirst: "AGENTS.md",

	// Coding and verification each have independent capacity, bounded by parallel.
	// Up to 2 * parallel worktrees retain ownership through verification/integration.
	// Conflicts never narrow global capacity. Overlapping [areas] and unverified [after]
	// prerequisites still prevent dispatch; worktrees:false serializes the whole pipeline.
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
	autoSplit: true, // an item that is still too big after the last size level is split into 2–splitMax parts (never for BLOCKED)
	splitMax: 4,
	// Derived items (split parts beyond the parent, gap fixes, repairs) the queue may add on its own.
	// 0 = automatic: max(8, 30% of the planned items). When it is used up, nothing more is split or added: items fail for you.
	growthMax: 0,
	maxGapItems: 3, // a [check] round adds at most this many fix items (gaps on overlapping areas are merged)
	redoOnConflict: true, // a conflicting item is redone on the latest code in the same session
	deferBlocked: true, // an item that says BLOCKED while other work is still pending is retried once after that work
	autoFix: true, // a [check] item that reports GAP: lines gets fix items queued before it, then checks again
	gapRounds: 2, // how many fix rounds a [check] item may trigger
	recheck: true, // a passed [check] item runs again when an item it covers ([areas] overlap or [after]) changes later
	fixRounds: 2,
	maxWaits: 3, // how often one item may say WAITING: <ids> before it is treated as BLOCKED
	outageMinutes: 180, // a provider/session error before any work is waited out (growing pauses) for up to this long, per item
	autonomy: "full", // "full": the automatic manager also answers BLOCKED: decision questions from the plan and logs them in decisions.md; "ask": they wait for you
	retryTransient: true,
	releaseDependents: true, // when a failed item is out of automatic retries, items that wait on it run anyway (told it failed) instead of the night ending
	minFreeMemoryGB: 0, // 0 = automatic: max(4 GB, 12% of RAM). No new item starts while less memory is available
	killStrays: true, // after each item, stop processes left running inside its worktree (dev servers, emulators, watchers) and simulators it booted // timeouts and session/provider errors are retried by the supervisor without a model diagnosis
	autoReconcile: true, // on start, preserve and release workers interrupted by a crash, sleep or a Pi Web restart
	keepAwake: true, // macOS: keep the machine from idle-sleeping while the queue is supervised (caffeinate)
	generatedPaths: [], // extra generated files/folders whose lines do not count toward size limits (lockfiles and __snapshots__ never count)
	tiers: {}, // named model/effort/limit presets for [tier: name] items, set by the plan (task.json "tiers")
	checkMinutes: 15,
	stopAfterFailuresInARow: 0, // disabled by default; positive finite values opt into a global safety halt

	// Sessions
	model: "", // empty: Pi's default model; or "provider/model-id"
	thinking: "high",
	piCommand: "",
	manager: true, // a detached supervisor diagnoses failures after approved handoff; healthy ticks use no model
	runIn: "auto", // "auto": items are Pi Web sessions when Pi Web runs, else background `pi`; or "web" / "cli"
	// Background pi (no Pi Web): "rpc" keeps ONE pi process per worktree slot and reuses it for every item and turn;
	// "json" starts a new pi process for every turn (the old behaviour, much heavier).
	workerMode: "rpc",
	workerMcp: false, // MCP servers in item workers (each worker connects all of them; some start browsers). Off by default
	workerRecycle: 20, // a slot's pi process is restarted after this many item sessions, to bound memory growth
	subagents: false, // let item workers start subagents (each is another pi process). Off: parallel items already use the machine
	// Failed items are reworked instead of retried unchanged: a fresh read-only session finds out why from the code and
	// rewrites the item (real paths, a Done when the code can meet), makes it wait for the item that provides what it
	// lacks, or gives up with the reason. maxReworks per item; after that it fails for you and its dependents run anyway.
	rework: true,
	maxReworks: 2,
	widenScope: true, // autonomy full: an item that needs a few files outside allowedPaths gets them (logged in decisions.md)
	widenMax: 12, // at most this many extra files/folders per item
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
// IPC is a wake-up hint, never the source of truth. A supervisor may disconnect at any time.
export function notifyRunner(type, detail = {}) {
	try {
		if (process.connected && typeof process.send === "function") process.send({ ...detail, type }, () => {});
	} catch {}
}
export const firstLine = (s) => String(s ?? "").split("\n")[0];
export const tail = (s, n) => String(s ?? "").split("\n").slice(-n).join("\n");

/** The work list plus any items the runner split off, each right after its parent. Parents that were split are left out. */
export function allItems(queueText, state) {
	const out = [];
	const push = (it) => {
		// a reworked item keeps its id, key and kind; its text, areas and prerequisites come from the rework
		const rw = state.rewrites?.[it.key];
		const p = rw && parseQueue(`- [ ] ${rw}`)[0];
		if (p) it = { ...it, line: p.line, title: p.title, areas: p.areas, after: [...new Set([...(it.after ?? []), ...p.after])], rewritten: true };
		for (const line of state.fixes?.[it.key] ?? []) out.push(...parseQueue(line).map((f) => ({ ...f, child: true, fix: true, ...(f.id.startsWith(`${it.id}-repair`) ? { repairParent: it, after: it.after } : {}) })));
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

export const APPROVAL_VOLATILE = ["configVersion", "parallel", "parallelStart", "parallelMin", "piWebUrl", "keepAwake", "deleteSessions", "managerModel", "managerThinking", "workerMode", "workerMcp", "workerRecycle"];
export function approvedTask(repo, c) {
	if (!c.task || basename(c.task) !== c.task || [".", ".."].includes(c.task)) return undefined;
	const folder = join(repo, ".tasks", c.task);
	const task = loadJson(join(folder, "task.json"), {});
	const files = ["task.json", "brief.md", "rules.md", "questions.md", "items.md"];
	if (task.status !== "queued" || !task.queuedAt || files.some((f) => !existsSync(join(folder, f)))) return undefined;
	const text = (file) => { try { return readFileSync(join(folder, file), "utf8"); } catch { return ""; } };
	if (/^\s*-\s\[\s\]/m.test(text("questions.md"))) return undefined;
	if (JSON.stringify(task.allowedPaths) !== JSON.stringify(c.allowedPaths) || JSON.stringify(task.checks) !== JSON.stringify(c.checks)) return undefined;
	if (c.queue !== `.tasks/${c.task}/items.md`) return undefined;
	if ((task.recovery !== undefined || c.recovery !== undefined) && JSON.stringify(task.recovery) !== JSON.stringify(c.recovery)) return undefined;
	// Operational knobs (how many run at once, which Pi Web) are not part of what was approved:
	// changing them mid-run must not switch automatic management off.
	const pinned = Object.fromEntries(Object.entries(c).filter(([k]) => !APPROVAL_VOLATILE.includes(k)));
	return createHash("sha256").update(JSON.stringify([files.map(text), pinned])).digest("hex");
}

/** Failures automatic recovery must leave to a person: decisions, environment, scope, budgets. */
export const NEEDS_PERSON = /BLOCKED: (decision|env)\b|needs you|credentials?|missing contract|outside.*(scope|allowed)|not authorized|permission denied|growth budget/i;
/** Failures that say nothing about the code: retried without a model diagnosis. */
export const TRANSIENT = /^(timed out after|pi exited with an error|runner error|Pi Web|worker did not confirm|stopped by request|interrupted|conflict with an item merged meanwhile)/i;
export const DECISION = /BLOCKED: decision\b/i;

/** Derived items the queue added by itself (split parts beyond their parent, gap fixes, repairs). */
export function growthUsed(state) {
	let n = 0;
	for (const kids of Object.values(state.splits ?? {})) n += Math.max(0, kids.length - 1);
	for (const fixes of Object.values(state.fixes ?? {})) n += fixes.length;
	return n;
}
export function growthBudget(c, planned) {
	const configured = Math.floor(Number(c.growthMax));
	return configured > 0 ? configured : Math.max(8, Math.ceil(planned * 0.3));
}

/** Bound automatic work to a failed target and its startup-approved authority. */
export function validateRecovery(proposal, state, items, manager = {}, c = {}) {
	if (!["retry", "repair"].includes(proposal?.action) || !Array.isArray(proposal.ids) || !proposal.ids.length || typeof proposal.reason !== "string" || !proposal.reason.trim()) throw new Error("invalid recovery proposal");
	const ids = [...new Set(proposal.ids)];
	for (const id of ids) {
		const item = items.find((i) => i.id === id), failure = item && state.failed?.[item.key];
		if (!failure || state.done?.[item.key] || (manager.attempts?.[id] ?? 0) >= (c.recovery?.maxAttempts ?? 2)) throw new Error(`${id}: not failed or recovery budget exhausted`);
		if (Object.values(state.running ?? {}).some((r) => !r || (!r.id && !r.key) || r.key === item.key || r.id === id)) throw new Error(`${id}: worker still owns the item`);
		if (/^depends on \S+, which (failed|is unknown)$/.test(failure)) throw new Error(`${id}: recover the failed prerequisite instead`);
		const decided = proposal.decided === true && c.autonomy === "full" && DECISION.test(failure) && !NEEDS_PERSON.test(failure.replace(DECISION, ""));
		if (NEEDS_PERSON.test(failure) && !decided) throw new Error(`${id}: needs human attention, not automatic recovery`);
	}
	const action = { action: proposal.action, ids, reason: proposal.reason.slice(0, 3000), ...(proposal.decided === true ? { decided: true } : {}) };
	if (proposal.action === "retry") return action;
	const parent = items.find((i) => i.id === ids[0]);
	if (!c.recovery || ids.length !== 1 || parent.child || parent.added || !Array.isArray(proposal.lines) || !proposal.lines.length || proposal.lines.length > 3 || (manager.repairs ?? 0) + proposal.lines.length > c.recovery.maxRepairs) throw new Error("repair authority or budget exceeded");
	const start = (state.fixes?.[parent.key] ?? []).length;
	const lines = proposal.lines.map((raw, index) => {
		if (typeof raw !== "string" || /[\r\n]/.test(raw) || raw.length > 3000) throw new Error("repair must be one bounded work line");
		const body = raw.trim().replace(/^-\s\[\s\]\s*/, "").replace(/^[A-Z]+\d+[A-Za-z0-9-]*\s*[—:-]\s*/, "");
		if (!/Done when:\s*\S/i.test(body) || /\[(?!areas?:)[^\]]*\]/i.test(body)) throw new Error("repair requires Done when and areas only; session, limits and dependencies are inherited");
		const line = `- [ ] ${parent.id}-repair${start + index + 1} — ${body}`;
		const repair = parseQueue(line)[0];
		if (!repair.areas.length || repair.areas.some((a) => /[*?\[\]{}]/.test(a) || !pathAllowed(a, parent.areas ?? []) || !pathAllowed(a, c.allowedPaths ?? []))) throw new Error("repair areas exceed the original item/task scope");
		return line;
	});
	const repairs = lines.flatMap((line) => parseQueue(line).map((i) => ({ ...i, after: parent.after })));
	dependencyGraph([...items.map((i) => i === parent ? { ...i, after: [...(i.after ?? []), ...repairs.map((r) => r.id)] } : i), ...repairs]);
	return { ...action, lines };
}

/** Changes asked for by you or the manager. Applied by the runner between items, or directly when it is not running. */
export function applyControl(state, items, ctl) {
	const pick = (ids) => {
		const want = (ids ?? []).map((x) => String(x).trim()).filter(Boolean);
		return items.filter((i) => want.length === 0 || want.some((w) => i.id === w || (ctl.by !== "auto" && i.id.startsWith(w))));
	};
	const changed = [];
	if (ctl.action === "repair") {
		const parent = items.find((i) => i.id === ctl.ids[0]);
		state.fixes = { ...(state.fixes ?? {}), [parent.key]: [...(state.fixes?.[parent.key] ?? []), ...ctl.lines] };
		state.waitFor = { ...(state.waitFor ?? {}), [parent.key]: [...(state.waitFor?.[parent.key] ?? []), ...ctl.lines.flatMap((l) => parseQueue(l).map((i) => i.id))] };
		delete state.failed[parent.key];
		changed.push(parent.id);
	} else if (ctl.action === "retry") {
		for (const i of pick(ctl.ids)) {
			// a second try on the same model and effort mostly repeats the failure: each retry runs stronger
			if (state.failed[i.key] && !TRANSIENT.test(state.failed[i.key])) state.boost = { ...(state.boost ?? {}), [i.key]: (state.boost?.[i.key] ?? 0) + 1 };
			// a person stepped in (an answer, more limits, their own retry): the item may be reworked again
			if (ctl.by !== "auto" && state.reworks?.[i.key]) delete state.reworks[i.key];
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
		const selected = ctl.ids?.length ? ctl.ids.flatMap((id) => pick([id])) : pick([]);
		const keys = [...new Set(selected.filter((i) => !state.done[i.key]).map((i) => i.key))];
		for (const k of keys) {
			delete state.failed[k];
			if (state.retried) delete state.retried[k];
			if (state.deferred) delete state.deferred[k];
		}
		state.priority = [...new Set([...keys, ...(state.priority ?? [])])];
		changed.push(...items.filter((i) => keys.includes(i.key)).map((i) => i.id));
	} else if (ctl.action === "release") {
		// a failed item will not be fixed automatically: what waits on it may run anyway, knowing it failed
		for (const i of pick(ctl.ids)) {
			if (!state.failed[i.key] || state.released?.[i.key]) continue;
			state.released = { ...(state.released ?? {}), [i.key]: state.failed[i.key] };
			changed.push(i.id);
			for (const d of items) {
				if (new RegExp(`^depends on ${i.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]?, which failed$`).test(state.failed[d.key] ?? "")) { delete state.failed[d.key]; changed.push(d.id); }
			}
		}
	} else if (ctl.action === "skip") {
		// the user accepts these as done without running them: dependents may proceed
		for (const i of pick(ctl.ids)) {
			if (state.done[i.key]) continue;
			state.done[i.key] = "skipped";
			delete state.failed[i.key];
			if (state.retried) delete state.retried[i.key];
			if (state.deferred) delete state.deferred[i.key];
			changed.push(i.id);
		}
	} else if (ctl.action === "amend") {
		// Change one item without editing items.md: its id, state key, dependents and the approval all stay.
		// paths: extra files it may change (beyond allowedPaths); line: its new text (same id). Then it runs again.
		const i = items.find((x) => x.id === String(ctl.ids?.[0] ?? "").trim());
		if (i && !state.done[i.key] && !Object.values(state.running ?? {}).some((r) => r?.key === i.key)) {
			const paths = (ctl.paths ?? []).map((p) => String(p).trim().replace(/^\.\//, "")).filter(widenable);
			if (paths.length) state.scope = { ...(state.scope ?? {}), [i.key]: [...new Set([...(state.scope?.[i.key] ?? []), ...paths])] };
			const text = String(ctl.line ?? "").trim().replace(/^-\s\[\s\]\s*/, "");
			const parsed = text && (() => { try { return parseQueue(`- [ ] ${text.startsWith(i.id) ? text : `${i.id} — ${text}`}`)[0]; } catch { return undefined; } })();
			const valid = parsed && /Done when:\s*\S/i.test(parsed.line) && parsed.id === i.id;
			if (valid) state.rewrites = { ...(state.rewrites ?? {}), [i.key]: parsed.line };
			if (paths.length || valid) {
				delete state.failed[i.key];
				if (state.reworks) delete state.reworks[i.key];
				if (state.retried) delete state.retried[i.key];
				if (state.deferred) delete state.deferred[i.key];
				changed.push(i.id);
			}
		}
	} else if (ctl.action === "limits") {
		// raise (or set) size/time limits for these items, then let them run again
		const limits = Object.fromEntries(LIMIT_KEYS.filter((k) => Number(ctl.limits?.[k]) > 0).map((k) => [k, Math.floor(Number(ctl.limits[k]))]));
		for (const i of pick(ctl.ids)) {
			if (state.done[i.key]) continue;
			state.limits = { ...(state.limits ?? {}), [i.key]: { ...(state.limits?.[i.key] ?? {}), ...limits } };
			delete state.failed[i.key];
			if (state.retried) delete state.retried[i.key];
			if (state.deferred) delete state.deferred[i.key];
			changed.push(i.id);
		}
	} else if (ctl.action === "add") {
		const lines = (ctl.lines ?? []).map((l) => (String(l).trim().startsWith("- [ ]") ? String(l).trim() : `- [ ] ${String(l).trim()}`));
		state.added = [...(state.added ?? []), ...lines];
		changed.push(...lines.flatMap((l) => parseQueue(l).map((i) => i.id)));
	}
	if (changed.length) changed.push(...reopenDependents(state, items));
	return changed;
}

/** Items that never started because a prerequisite failed: open again once it no longer fails (it passed, was
 *  retried or released). Only scheduler-made "depends on" failures; real worker failures keep their evidence. */
export function reopenDependents(state, items) {
	const reopened = [];
	for (let again = true; again;) {
		again = false;
		for (const i of items) {
			const dependency = state.failed[i.key]?.match(/^depends on (\S+), which failed$/)?.[1];
			const parents = dependency && items.filter((p) => p.id === dependency || (p.child && p.id.startsWith(dependency) && /^[a-z]$/.test(p.id.slice(dependency.length))));
			if (parents?.length && parents.every((p) => !state.failed[p.key] || state.released?.[p.key])) { delete state.failed[i.key]; again = true; reopened.push(i.id); }
		}
	}
	return reopened;
}

function overtimePrompt(c) {
	return `You ran out of time before replying. Do not start anything new. Finish the change you were making so that it is complete and consistent, run ${checksText(c)}, and reply as instructed (DONE with the changed files, or WAITING / BLOCKED). If the item is clearly too big to finish now, reply NEEDS: <files> files, <lines> lines.`;
}

function splitPrompt(c, item, reason) {
	return `This item is too big to finish in one session even at the highest size limits (${firstLine(reason).slice(0, 200)}).

Do NOT edit any file. Split it into as FEW parts as possible: 2 to ${c.splitMax ?? 4}, never more. Together they must cover everything it requires. Each must be doable on its own by a fresh agent in one session, touch a different set of files than the others, and leave the checks passing. Do not create parts for trivial edits; fold them into the part that touches the same files. Use [after] only for actual prerequisites; independent parts must be runnable in parallel, not chained by list order.

Reply with one line per item, in order, each starting with "ITEM: ", then what to do, then "Done when: <something observable>", then the tags [areas: <folders or files it changes, comma separated>] and, only if it needs earlier parts finished first, [after: <their numbers, e.g. 1, 2>]. Parts are numbered from 1 in the order you list them. No other text. If it truly cannot be split, reply with one line: BLOCKED: <reason>`;
}

/** Failed items grouped by what they need, each with how many other items it holds up. */
export function failureGroups(items, state) {
	const failed = items.filter((i) => state.failed?.[i.key]);
	const blockedBy = (id) => {
		const seen = new Set();
		for (let grew = true; grew;) {
			grew = false;
			for (const i of failed) {
				const dep = state.failed[i.key].match(/^depends on (\S+), which/)?.[1];
				if (dep && !seen.has(i.id) && (dep === id || seen.has(dep) || id.startsWith(dep) && /^[a-z]$/.test(id.slice(dep.length)))) { seen.add(i.id); grew = true; }
			}
		}
		return seen.size;
	};
	const kinds = [
		["needs your decision", /BLOCKED: decision\b/i],
		["needs environment or credentials", /BLOCKED: env\b|credentials?|permission denied|not authorized/i],
		["outside the allowed scope", /outside|files outside/i],
		["growth budget used up", /growth budget/i],
		["blocked (other)", /BLOCKED/i],
		["checks failed", /check failed|breaks checks|gaps remain/i],
		["too big", /net added lines|files gain lines|NEEDS/i],
		["timed out or session error", /timed out|pi exited|runner error|Pi Web/i],
		["no changes made", /no changes/i],
	];
	const groups = new Map();
	let waiting = 0;
	for (const i of failed) {
		const reason = state.failed[i.key];
		if (/^depends on \S+, which/.test(reason)) { waiting++; continue; }
		const kind = kinds.find(([, re]) => re.test(reason))?.[0] ?? "other";
		if (!groups.has(kind)) groups.set(kind, []);
		groups.get(kind).push({ id: i.id, title: i.title, reason, blocks: blockedBy(i.id) });
	}
	return { groups: [...groups].map(([kind, list]) => ({ kind, items: list.sort((a, b) => b.blocks - a.blocks) })), waiting };
}

export function runReport(items, state) {
	const { groups, waiting } = failureGroups(items, state);
	const done = items.filter((i) => state.done?.[i.key]).length;
	const open = items.filter((i) => !state.done?.[i.key] && !state.failed?.[i.key]).length;
	const needs = items.filter((i) => NEEDS_PERSON.test(state.failed?.[i.key] ?? "")).length;
	const lines = [`# Queue report · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "", `${items.length} items: **${done} landed** · **${items.length - done - open - waiting} failed** (${needs} need you) · **${waiting} never started** (a prerequisite failed; they run by themselves once it passes) · ${open} still open. The queue added ${growthUsed(state)} item(s) by itself.`];
	for (const g of groups) {
		lines.push("", `## ${g.kind} (${g.items.length})`);
		for (const f of g.items) lines.push(`- ${f.id}${f.blocks ? ` (holds up ${f.blocks})` : ""} — ${f.title.slice(0, 80)}: ${f.reason.slice(0, 240)}`);
	}
	if (!groups.length) lines.push("", open ? "Nothing failed so far." : "Everything passed.");
	return lines.join("\n");
}

/** Fold a check's GAP lines into at most `max` fix items: gaps on overlapping areas always share one item. */
/**
 * Turns a [check]'s GAP findings into fix jobs. Each finding is its own job. Two findings are merged only to fit
 * `room`, and only when the merged job still changes at most `maxFiles` files: findings that share a file (a test
 * fixture, say) stay separate jobs and run one after the other (their areas overlap). Findings that do not fit the
 * room are returned as `leftover` (fixed in the next round, never dropped); findings without areas, or outside the
 * allowed paths, as `rejected`.
 */
export function planGapJobs(gaps, { room = 3, maxFiles = 5, allowedPaths } = {}) {
	const rejected = [], jobs = [];
	for (const g of gaps) {
		const areas = [...new Set((g.match(/\[areas?:\s*([^\]]+)\]/i)?.[1] ?? "").split(",").map((a) => a.trim()).filter(Boolean))];
		const body = g.replace(/\s*\[areas?:[^\]]*\]/gi, "").trim();
		const [what, done] = body.split(/\s*Done when:\s*/i);
		if (!areas.length) { rejected.push({ gap: g, why: "no [areas: …]" }); continue; }
		const outside = allowedPaths ? areas.filter((a) => !pathAllowed(a, allowedPaths)) : [];
		if (outside.length) { rejected.push({ gap: g, why: `outside the allowed paths: ${outside.join(", ")}` }); continue; }
		jobs.push({ parts: [{ what: what.replace(/[.\s]+$/, ""), done: (done ?? "").replace(/[.\s]+$/, "") }], areas });
	}
	const union = (a, b) => [...new Set([...a.areas, ...b.areas])];
	while (jobs.length > Math.max(1, room)) {
		let best;
		for (let x = 0; x < jobs.length; x++)
			for (let y = x + 1; y < jobs.length; y++) {
				const size = union(jobs[x], jobs[y]).length;
				if (size <= maxFiles && (!best || size < best.size)) best = { x, y, size };
			}
		if (!best) break; // nothing fits together under the file limit: the rest waits for the next round
		const b = jobs.splice(best.y, 1)[0], a = jobs[best.x];
		jobs[best.x] = { parts: [...a.parts, ...b.parts], areas: union(a, b) };
	}
	const take = jobs.slice(0, Math.max(1, room)), leftover = jobs.slice(take.length);
	const line = ({ parts, areas }) => {
		const what = parts.map((p) => p.what).join("; ");
		const done = parts.map((p) => p.done).filter(Boolean).join("; and ") || "the check can verify it";
		// one finding that by itself needs more files than the limit starts at what it needs (never by merging)
		return `${what}. Done when: ${done}. [areas: ${areas.join(", ")}]${areas.length > maxFiles ? ` [files=${areas.length}]` : ""}`;
	};
	return { jobs: take.map(line), leftover: leftover.map(line), rejected };
}

/** Compatibility: the fix job lines only. */
export function mergeGaps(gaps, max, opts = {}) {
	return planGapJobs(gaps, { room: max, maxFiles: opts.maxFiles ?? Infinity, allowedPaths: opts.allowedPaths }).jobs;
}

/**
 * The admission check every job the queue generates passes before it is queued: gap fixes, split parts, repairs,
 * reworked items and added lines. A job that fails it never costs a worker turn. Returns the reason, or undefined.
 */
export function admissionProblem(line, c, items = [], { maxFiles } = {}) {
	let job;
	try { job = parseQueue(line.startsWith("- [ ]") ? line : `- [ ] ${line}`)[0]; } catch (e) { return e.message; }
	if (!job) return "not a work line";
	if (!/Done when:\s*\S/i.test(job.line)) return `${job.id}: no "Done when"`;
	if (!job.areas?.length) return `${job.id}: no [areas: …]`;
	const outside = job.areas.filter((a) => !pathAllowed(a, c.allowedPaths ?? []));
	if (outside.length) return `${job.id}: areas outside the allowed paths: ${outside.join(", ")}`;
	let jc;
	try { jc = itemConfig(c, job); } catch (e) { return e.message; }
	// the job's own limit (its [files=] tag included); split parts may start higher, at the top size level
	const limit = maxFiles ?? jc.maxFilesGrowing ?? 5;
	const concrete = job.areas.filter((a) => !/[*?[{]/.test(a) && /\.[A-Za-z0-9]+$/.test(a));
	if (concrete.length > limit) return `${job.id}: names ${concrete.length} files, more than its limit of ${limit}`;
	if (!job.check && !job.readonly && !(jc.checks ?? []).length && (c.checks ?? []).length) return `${job.id}: no checks resolve for it`;
	const known = new Set(items.map((i) => i.id));
	const unknown = (job.after ?? []).filter((d) => d !== "*" && !known.has(d) && !items.some((i) => i.child && i.id.startsWith(d)));
	if (unknown.length) return `${job.id}: [after] names unknown items: ${unknown.join(", ")}`;
	if (known.has(job.id)) return `${job.id}: the id is already used`;
	return undefined;
}

/** Do two [areas: …] lists touch the same path? (prefix match; globs cut at the first *) */
export function areasOverlap(a, b) {
	const norm = (p) => {
		const literal = p.split(/[*?[{]/)[0];
		const prefix = literal === p ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
		const value = posix.normalize(prefix || ".").replace(/\/+$/, "");
		return value === "." ? "" : value;
	};
	for (const x of a.map(norm))
		for (const y of b.map(norm)) {
			if (!x || !y || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
		}
	return false;
}

const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** A retried item runs on the plan's heavy tier (if any) with more reasoning and time. */
export function boosted(c, level) {
	const heavy = c.tiers?.heavy ?? {};
	const at = Math.max(EFFORT.indexOf(c.thinking ?? "medium"), EFFORT.indexOf(heavy.thinking ?? "high"));
	return {
		...c,
		model: heavy.model ?? c.model,
		thinking: EFFORT[Math.min(EFFORT.length - 2, Math.max(at, EFFORT.indexOf("high")) + (level > 1 ? 1 : 0))],
		itemMinutes: Math.min(240, Math.round((c.itemMinutes ?? 40) * (1 + 0.5 * level))),
	};
}

/** An id and the ids it was generated from, nearest first: V90a-fix1 → V90a-fix1, V90a, V90. */
export function checkOwners(id) {
	const out = [id];
	for (let cur = id, prev; cur !== prev;) {
		prev = cur;
		cur = /-(fix|repair)\d+$/.test(cur) ? cur.replace(/-(fix|repair)\d+$/, "") : cur.replace(/^([A-Z]+\d+[A-Za-z0-9-]*?)[a-z]$/, "$1");
		if (cur !== prev) out.push(cur);
	}
	return out;
}

export const TIER_KEYS = ["model", "thinking", "maxNetLines", "maxFilesGrowing", "itemMinutes"];
export const LIMIT_KEYS = ["maxNetLines", "maxFilesGrowing", "itemMinutes"];

/** Per-item limits and session selection; omitted tags inherit the queue defaults. */
export function itemConfig(c, item) {
	if (item.repairParent) return { ...itemConfig(c, item.repairParent), allowedPaths: item.areas };
	const out = { ...c };
	if (c.itemChecks) {
		// generated items (A01a split parts, V90-fix1 gap fixes, X-repair1, their own parts) use the checks of the planned item they came from
		const checks = checkOwners(item.id).map((id) => c.itemChecks[id]).find((x) => x !== undefined);
		if (!Array.isArray(checks) || checks.some((cmd) => typeof cmd !== "string" || !cmd.trim())) throw new Error(`${item.id}: missing or invalid focused itemChecks`);
		out.checks = [...new Set([...c.checks, ...checks])];
	}
	const tierTags = [...item.line.matchAll(/\[tier:\s*([^\]]*)\]/gi)];
	if (tierTags.length > 1) throw new Error(`${item.id}: duplicate [tier: …] tags`);
	if (tierTags.length) {
		const name = tierTags[0][1].trim();
		const tier = c.tiers?.[name];
		if (!tier || typeof tier !== "object") throw new Error(`${item.id}: unknown [tier: ${name}] (task.json "tiers" defines: ${Object.keys(c.tiers ?? {}).join(", ") || "none"})`);
		for (const key of TIER_KEYS) if (tier[key] !== undefined) out[key] = tier[key];
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
		for (const tag of ["areas?", "after", "produces"]) if ([...line.matchAll(new RegExp(`\\[${tag}:`, "gi"))].length > 1) throw new Error(`duplicate [${tag}] tag: ${line}`);
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
			title: title.replace(/\s*\[(areas?|after|produces|model|thinking|tier|big|check|readonly|files=|lines=|min=)[^\]]*\]/gi, "").trim(),
			line,
			areas: tag("areas?"),
			after: tag("after"),
			produces: tag("produces"), // files later items read: the item passes only when they exist
			check: /\[check\]/i.test(line),
			readonly: /\[readonly\]/i.test(line),
		});
	}
	return items;
}

/** Resolve real prerequisites, including split-parent aliases; reject cycles before dispatch. */
export function dependencyGraph(items) {
	const byId = new Map(items.map((i) => [i.id, i]));
	if (byId.size !== items.length) throw new Error("duplicate queue item ids");
	const graph = new Map();
	for (const i of items) {
		const deps = (i.after ?? []).flatMap((id) => {
			if (id === "*") return items.filter((o) => o !== i && !(o.after ?? []).includes("*")).map((o) => o.id);
			if (byId.has(id)) return [id];
			const children = items.filter((o) => o.child && o.id.startsWith(id) && /^[a-z]$/.test(o.id.slice(id.length)));
			if (!children.length) throw new Error(`${i.id}: unknown dependency ${id}`);
			return children.map((o) => o.id);
		});
		graph.set(i.id, [...new Set(deps)]);
	}
	const done = new Set(), visiting = [];
	const visit = (id) => {
		if (visiting.includes(id)) throw new Error(`dependency cycle: ${[...visiting.slice(visiting.indexOf(id)), id].join(" → ")}`);
		if (done.has(id)) return;
		visiting.push(id);
		for (const dep of graph.get(id)) visit(dep);
		visiting.pop();
		done.add(id);
	};
	for (const id of graph.keys()) visit(id);
	return graph;
}

/** How many rounds a plan needs with `parallel` workers when every item takes one round (dependencies and area locks applied). */
export function simulatePlan(items, parallel) {
	const graph = dependencyGraph(items), done = new Set();
	let left = [...items], rounds = 0;
	while (left.length) {
		const now = [];
		for (const i of left) {
			if (now.length >= parallel) break;
			if (!graph.get(i.id).every((d) => done.has(d))) continue;
			if (!i.readonly && now.some((r) => !r.readonly && r.areas?.length && i.areas?.length && areasOverlap(r.areas, i.areas))) continue;
			now.push(i);
		}
		if (!now.length) break;
		rounds++;
		for (const i of now) done.add(i.id);
		left = left.filter((i) => !done.has(i.id));
	}
	const depth = new Map();
	const chain = (id) => depth.get(id) ?? (depth.set(id, 0), depth.set(id, 1 + Math.max(0, ...graph.get(id).map(chain))), depth.get(id));
	return { rounds, ideal: Math.ceil(items.length / Math.max(1, parallel)), criticalPath: Math.max(0, ...items.map((i) => chain(i.id))) };
}

/** Objective plan defects that waste sessions or serialize the queue. Returned to the planner at handoff. */
export function planLint(items, parallel) {
	const findings = [];
	const work = items.filter((i) => !i.check && !i.readonly); // read-only audits share areas by design
	const graph = dependencyGraph(items);
	// 1. items on exactly the same files with no order between them: they run one after another anyway
	const byAreas = new Map();
	for (const i of work) {
		if (!i.areas?.length) continue;
		const k = [...i.areas].sort().join(",");
		byAreas.set(k, [...(byAreas.get(k) ?? []), i]);
	}
	for (const [areas, group] of byAreas) {
		const ids = new Set(group.map((i) => i.id));
		const free = group.filter((i) => !graph.get(i.id).some((d) => ids.has(d)) && !group.some((o) => graph.get(o.id).includes(i.id)));
		if (free.length >= 3) findings.push(`merge ${free.map((i) => i.id).join(", ")}: they all change only [${areas}] and do not depend on each other, so they would run one at a time as ${free.length} separate sessions. Make them one item (or two) with a combined "Done when".`);
	}
	// 2. an item that names another item but does not wait for it
	const ids = new Set(items.map((i) => i.id));
	for (const i of items) {
		const text = i.line.replace(/\[[^\]]*\]/g, " ").replace(/^[A-Z]+\d+[A-Za-z0-9-]*/, "");
		const named = [...new Set(text.match(/\b[A-Z]+\d+[a-z]?\b/g) ?? [])].filter((id) => ids.has(id) && id !== i.id && !graph.get(i.id).includes(id) && !(i.after ?? []).includes("*"));
		if (named.length) findings.push(`${i.id} mentions ${named.join(", ")} but has no [after: ${named.join(", ")}]: add it (or reword the item) so it cannot run first and block.`);
	}
	// 3. "Done when" that lets the item pass without the change ("otherwise keep the original and report why")
	for (const i of work) {
		const done = i.line.split(/Done when:/i)[1]?.replace(/\[[^\]]*\]/g, " ") ?? "";
		const hatch = done.match(/[^.;]*\b((unavailable|incompatible|slower|not possible|infeasible|fails?|otherwise|if not|else)\b[^.;]{0,100}\b(keep|retain|report|document|skip|leave|fall ?back)|(report|document)s? (why|the reason)|keep(s|ing)? (the )?(original|old|existing) (one|implementation|compiler|tool|setup|config))\b[^.;]*/i)?.[0]?.trim();
		if (hatch) findings.push(`${i.id}: its "Done when" passes without the change ("${hatch.slice(0, 140)}"). A worker under a size limit will take that exit and report DONE. Make the target state the only passing outcome; if keeping the old way is genuinely acceptable, decide that now (questions.md) and say so plainly.`);
	}
	// 4. the plan cannot use the parallelism it asks for
	const sim = simulatePlan(items, parallel);
	const floor = Math.max(sim.ideal, sim.criticalPath);
	if (items.length >= 8 && parallel > 1 && sim.rounds > 1.6 * floor) {
		const count = new Map();
		for (const i of work) for (const a of new Set(i.areas ?? [])) count.set(a, (count.get(a) ?? 0) + work.filter((o) => o !== i && areasOverlap([a], o.areas ?? [])).length);
		const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
		findings.push(`with parallel ${parallel} this plan needs about ${sim.rounds} rounds where ${floor} would do: too many items lock the same paths (most contended: ${top.join(", ")}). Narrow [areas] to the files each item really edits, or merge items that share files.`);
	}
	if (work.length > 80) findings.push(`${work.length} work items is a lot: every item costs a full agent session (reading the plan, checks, a merge). Fold small edits (copy text, renames, one-line changes) into the item that touches the same screen or module; aim for items of roughly 10–40 minutes of agent work.`);
	return { findings, ...sim };
}

/** Prefer work that unlocks the longest remaining chain; explicit next order wins. */
export function orderQueue(items, state) {
	const graph = dependencyGraph(items), children = new Map(items.map((i) => [i.id, []]));
	for (const i of items) if (!state.done?.[i.key] && !state.failed?.[i.key]) for (const dep of graph.get(i.id)) children.get(dep).push(i.id);
	const scores = new Map();
	const score = (id) => {
		if (!scores.has(id)) scores.set(id, 1 + Math.max(0, ...children.get(id).map(score)));
		return scores.get(id);
	};
	const priority = state.priority ?? [];
	const rank = (i) => priority.includes(i.key) ? priority.indexOf(i.key) : priority.length;
	const parked = (i) => Number(!!(state.retried?.[i.key] || state.deferred?.[i.key]));
	return [...items].sort((a, b) => parked(a) - parked(b) || rank(a) - rank(b) || score(b.id) - score(a.id));
}

export function loadJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

export function saveJson(file, value) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, file);
}

export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Exclusive process ownership. Missing/partial owner records fail closed. */
export function acquireProcessLock(file) {
	const claim = () => {
		const fd = openSync(file, "wx");
		try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
	};
	try { claim(); } catch (e) {
		if (e.code !== "EEXIST") throw e;
		const reclaim = `${file}.reclaim`;
		const fd = openSync(reclaim, "wx");
		try {
			const pid = Number(readFileSync(file, "utf8"));
			if (!pid || pidAlive(pid)) throw new Error(`process already owns ${file}`);
			rmSync(file);
			claim();
		} finally { closeSync(fd); rmSync(reclaim, { force: true }); }
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try { if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file); } catch {}
	};
}

export function enqueueControl(repo, control) {
	const dir = join(repo, DIR, "control");
	mkdirSync(dir, { recursive: true });
	saveJson(join(dir, `${Date.now()}-${randomUUID()}.json`), control);
}

export async function ensureDir(cwd, extraExcludes = []) {
	mkdirSync(join(cwd, DIR), { recursive: true });
	const rel = (await git(cwd, "rev-parse", "--git-path", "info/exclude")).out.trim();
	if (!rel) return;
	const exclude = isAbsolute(rel) ? rel : join(cwd, rel);
	try {
		mkdirSync(dirname(exclude), { recursive: true });
		const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		const missing = [`${DIR}/`, ...extraExcludes].filter((entry) => !cur.split("\n").includes(entry));
		if (missing.length) appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
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

export function pathAllowed(file, allowed) {
	const path = posix.normalize(file.replaceAll("\\", "/")).replace(/\/$/, "");
	if (isAbsolute(path) || path === ".." || path.startsWith("../") || /^[A-Za-z]:/.test(path)) return false;
	return allowed.some((entry) => {
		const prefix = posix.normalize(entry.replaceAll("\\", "/")).replace(/\/$/, "");
		return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
	});
}

/** Machine-written files: they must still be in scope, but their lines never count toward the size limits. */
export const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|go\.sum|go\.work\.sum|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock|flake\.lock)$|(^|\/)__snapshots__\//;
export function isGenerated(p, extra = []) {
	return GENERATED.test(p) || extra.some((g) => pathAllowed(p, [g]));
}

export async function measure(cwd, base, allowed, generated = []) {
	const files = new Set();
	let net = 0;
	let growing = 0;
	const inScope = (p) => pathAllowed(p, allowed);
	const counts = (p) => inScope(p) && !isGenerated(p, generated);
	const numstat = await git(cwd, "diff", "--numstat", "--no-renames", base);
	for (const row of numstat.out.split("\n")) {
		const [a, d, p] = row.split("\t");
		if (!p) continue;
		files.add(p);
		const delta = (Number(a) || 0) - (Number(d) || 0);
		if (counts(p)) {
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
		if (counts(p)) {
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
- Never remove a behaviour listed under "Protected" in the brief, even to make the change smaller.
${c.subagents === true ? "- You may use subagents to read, search and research. Only you edit files." : "- Do not start subagents or other agent sessions: other items run at the same time on this machine. Read and search yourself."}
- Do not ask the user questions. Do not commit. Do not touch git history or branches.
- Write focused regression coverage. The runner executes the configured checks after you stop, in separate verification capacity; do not run the mandatory suite in this coding turn. Use only a narrowly targeted diagnostic when needed to make the fix.${item.repaired ? "\n- Earlier verified repairs may already satisfy this item. Inspect them against the original Done when; if complete, report DONE without inventing another edit." : ""}
- If the item clearly needs more than these size limits, do not start editing: reply with exactly one line NEEDS: <files> files, <lines> lines (your honest estimate). The limits are then raised for you.
- If the current code already does everything "Done when" asks (another item did it), change nothing and reply with one line: ALREADY DONE: <where you verified it>. The runner still runs the checks.
- If it needs work from another queue item that has not landed yet, undo your edits and reply with one line: WAITING: <item ids, e.g. A03, B02> — <what is missing>. It runs again after them.
- If it cannot be done for any other reason, undo your edits and reply with exactly one line:
  BLOCKED: decision: <the question only the user can answer>   (a product/design choice the plan does not settle)
  BLOCKED: env: <what is missing>   (credentials, a service, a tool that is not installed)${c.autonomy === "full" && c.widenScope !== false && !item.readonly && !item.repairParent ? "\n  BLOCKED: scope: <exact repo-relative file>   (only the item's path list is in the way; the runner can add the file without asking). Never use this to override an explicit task restriction or bypass a check." : ""}
  BLOCKED: <reason>   (anything else, e.g. the plan contradicts the code)
  Prefer the plan's rules and the existing code's conventions over asking; only real gaps are BLOCKED.
- Stop every dev server, emulator, simulator, watcher or other background process you start before you reply. Never leave anything running.
- DONE means every condition in "Done when" now holds because of your change. Never keep the old implementation, deliver only part of the item, or replace the change with an explanation or documentation and call that DONE. If the whole item does not fit the limits, reply NEEDS; if it truly cannot be done, reply BLOCKED with the evidence.
- When finished, reply: DONE, then each changed file with one sentence.`;
}

// ---------- rework: change the item, not just run it again ----------

const PROTECTED = /(^|\/)(\.git|\.pi-queue|\.tasks|node_modules|\.github\/workflows)(\/|$)|(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)(\/|\.|$)|\.(pem|key|p12|keystore)$/i;
/** A path an item may be given beyond allowedPaths under full autonomy: inside the repo and not sensitive. */
export function widenable(p) {
	return typeof p === "string" && !!p.trim() && !isAbsolute(p) && !p.split("/").includes("..") && !PROTECTED.test(p);
}

/** Repo paths named in free text (an item, a failure, a worker's reply). */
export function mentionedPaths(text) {
	const plain = String(text ?? "").replace(/\b[a-z]+:\/\/\S+/gi, " ");
	return [...new Set((plain.match(/(?:[\w@.+-]+\/)+[\w@.+-]*[\w]/g) ?? []).map((p) => p.replace(/^\.\//, "")).filter((p) => !/^\d/.test(p) && !p.startsWith("@") && /[A-Za-z]/.test(p.split("/").at(-1))))];
}

/** Failures a rewritten item can fix. Not: provider/session errors (retried as they are), decisions and missing
 *  environment (a person or the manager answers those), budgets, stops. */
export function reworkable(reason) {
	return !!reason && !TRANSIENT.test(reason) && !/^agent: BLOCKED: (decision|env)\b/i.test(reason) && !/credentials?|permission denied|not authorized|^needs you|growth budget|^stopped by request|^commit failed|^could not fast-forward|^read-only item changed/i.test(reason);
}

// Unlike mentionedPaths (used for diagnostic hints), never extract a grant from part of a path.
function scopeFiles(reason) {
	const text = reason.replace(/^agent: BLOCKED:\s*/i, "");
	const words = (text.replace(/\[areas?:[^\]]*\]/gi, "").match(/`[^`]+`|[^\s]+/g) ?? []).map((w) => w.replace(/[.,;:]$/, "").replace(/^[`"'(]+|[`"')]+$/g, "").replace(/^\.\//, ""));
	return words.filter((w) => w.includes("/") || /\.[\w-]+$/.test(w) || (words.length === 2 && words[0] === "scope" && w !== "scope"));
}

function ordinaryScopeFile(wt, p) {
	if (!widenable(p) || posix.normalize(p) !== p || /[\\:*?\[\]{}]/.test(p) || p.endsWith("/")) return false;
	// A symlink anywhere in the path could turn an ordinary name into a protected or external target.
	try {
		let part = wt;
		for (const name of p.split("/")) {
			part = join(part, name);
			const stat = lstatSync(part, { throwIfNoEntry: false });
			if (stat && !(part === join(wt, p) ? stat.isFile() : stat.isDirectory())) return false;
		}
		return true;
	} catch { return false; }
}

function scopePrompt(c, paths) {
	return `You may now also change: ${paths.join(", ")} (added to this item's allowed files by the automatic manager).

Do the item now, including those files. Explicit task safety restrictions and all configured checks still apply; do not edit a gate to grant yourself access. Same other rules: only ${c.allowedPaths.join(", ")}, at most ${c.maxNetLines} net added lines, at most ${c.maxFilesGrowing} files gaining lines, no questions, no commits. Reply DONE, then each changed file with one sentence. If it still cannot be done, reply with one line: BLOCKED: <reason>`;
}

function reworkPrompt(c, item, reason, reply, missing, others) {
	return `A queue item failed. Running it again unchanged would fail the same way. Your job: find out from the code WHY it failed, then fix the ITEM (the instructions for the next worker), not the code.

Do NOT edit, create or delete any file (anything you change is thrown away). Read and search only. Do not start subagents.

ITEM: ${item.line}

It failed with:
${String(reason).slice(0, 4000)}

The worker's last reply:
${String(reply ?? "").slice(-3000) || "(none)"}
${missing.length ? `\nPaths named in the item or the failure that do not exist in the code now:\n${missing.map((m) => `- ${m.path}${m.hits.length ? ` · files with that name: ${m.hits.join(", ")}` : " · no file with that name"}${m.providers.length ? ` · named by open items ${m.providers.join(", ")}` : ""}`).join("\n")}\n` : ""}
Other items in the queue (id · status · title · areas):
${others}

Allowed paths: ${c.allowedPaths.join(", ")}

Reply with exactly ONE of these as the FIRST line of your reply, then at most a few lines of evidence:
REWRITE: <what to do, with the real file paths the code uses> Done when: <something observable the code can meet> [areas: <the real folders/files it changes>] [after: <ids of OPEN items it truly needs first, only if any>]
AFTER: <ids of OPEN items that must land first, comma separated> — <what they provide>
OBSOLETE: <where the code already meets every Done when condition>
GIVE UP: <why no instructions can work: a decision or something only a person can provide>

Keep the item's goal and every requirement; never make it easier by dropping parts. Fix wrong paths, wrong assumptions about the code, a missing prerequisite, a Done when that cannot be met as written, or files it must also change (name them in [areas]).`;
}

/** A DONE reply that admits part of the item was not done (kept the old way, hit a cap, deferred…). */
export const SHORTFALL = /\b(exceed(s|ed|ing)?|(line|size|file) (cap|limit)|over the (cap|limit)|retain(ed|s|ing)?|kept|keeps|keep(ing)? (the )?(old|original|existing|current)|instead of|fall ?back|not (implemented|adopted|migrated|enabled|done|completed|changed)|skipp(ed|ing)|deferred|left (for|as|unchanged)|out of scope|partial(ly)?|could not|couldn't|unable to|blocked by|remains? (unchanged|on|as)|unchanged)\b/i;

function confirmPrompt(c, item, reply) {
	const hint = reply.match(new RegExp(`[^\n]*${SHORTFALL.source}[^\n]*`, "i"))?.[0]?.trim().slice(0, 300) ?? "";
	return `Your DONE reply says: "${hint}". That reads as if part of the item was not done.

ITEM: ${item.line}

Compare the code now with every condition in "Done when". Keeping the old implementation, doing part of it, or explaining why instead of changing it is NOT done.
- If something is missing and it fits the limits (${c.maxFilesGrowing} files gaining lines, ${c.maxNetLines} net added lines; lockfiles do not count), finish it now and reply DONE.
- If it does not fit, reply NEEDS: <files> files, <lines> lines. If it truly cannot be done, reply BLOCKED: <evidence>.
- If every condition really holds, reply DONE: CONFIRMED, then one line per condition with where it holds.`;
}

// ---------- size limits: raised automatically, or when the person says so in the session ----------

const UNLIMITED = { maxNetLines: 5000, maxFilesGrowing: 200 };
const SIZE_REASON = /\b(limit|limits|net added|files? gain|five|5 files|150|broader|larger than|too (big|large)|exceed|beyond)\b/i;
const SCOPE_REASON = /\bBLOCKED: scope:|\b(out of scope|outside (of )?(the |its |my )?(item['’]s |item )?(declared )?(permitted|allowed|scope|\[?areas)|outside apps|not (in|within|under|part of) (the )?(allowed|permitted)|frozen|not permitted)\b/i;

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
		if (!file && ref.web && ref.id) file = await ref.web.send(ref.id, { type: "get_state" }).then((r) => r?.data?.sessionFile);
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

Do the item now within the raised limits. Keep any edits that are already right. Same other rules: only ${c.allowedPaths.join(", ")}, no questions, no commits. Reply DONE when edits are ready; the runner executes the configured checks in verification capacity. If it still cannot be done, reply with one line: BLOCKED: <reason>`;
}

function redoPrompt(c, reason) {
	return `Other items were merged into the branch while you worked, and your change no longer fits (${firstLine(reason)}). The worktree has been reset to the latest code.

Do this item again on top of it. Reuse your earlier approach, but first look at what changed in the files you touched. Same rules and limits: only ${c.allowedPaths.join(", ")}, at most ${c.maxNetLines} net added lines, at most ${c.maxFilesGrowing} files gaining lines, no questions, no commits. Reply DONE when edits are ready; the runner executes the configured checks in verification capacity. If it cannot be done, reply with one line: BLOCKED: <reason>`;
}

function checkPrompt(c, item) {
	return `You are doing ONE CHECK item, unattended. Nobody can answer questions. A script checks your work when you stop.

CHECK: ${item.line}

Read first: ${c.readFirst}.

Verify what the check describes against the current code (read it, run tests/commands that are safe to run).
- You may fix tests, fixtures and docs under ${c.allowedPaths.join(", ")} when they are wrong or missing. Do not change production code.
- If production code does not do what the plan requires, do not fix it. Report each gap on its own line:
  GAP: <what is wrong and what to change, naming the files>. Done when: <observable result>. [areas: <folders/files the fix changes>]
- Judge each covered item by the code, not by its DONE message, notes or commit message. A passed item that kept the old implementation, did only part of its "Done when", or documented why instead of changing it, is a GAP.
- If everything holds, reply: CHECKED, then one line per thing you verified or fixed.
- If you cannot check it at all (missing environment, credentials, or a decision), reply with exactly one line: BLOCKED: <reason>
- Do not ask questions. Do not commit. Before you stop, run: ${checksText(c)}`;
}

function fixPrompt(c, reason) {
	return `The script rejected the change: ${reason}

Fix only that, without dropping any part of the item: the item's "Done when" must still fully hold afterwards. Same rules: only ${c.allowedPaths.join(", ")}, at most ${c.maxNetLines} net added lines, at most ${c.maxFilesGrowing} files gaining lines, no new abstractions, no questions, no commits. If it cannot be fixed within the rules, undo your edits and reply with one line: BLOCKED: <reason>`;
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
		const previous = sessionFiles(ctx.repo, [sessionId])[sessionId];
		const args = ["--mode", "json", "--session-dir", join(ctx.repo, DIR, "sessions"), ...(previous ? ["--session", previous] : ["--session-id", sessionId]), "-n", name];
		if (c.model) args.push("--model", c.model);
		if (c.thinking) args.push("--thinking", c.thinking);
		if (ctx.manager) args.push("--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates");
		args.push(prompt);
		const child = spawn(pi, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		ctx.onWorker?.({ pid: child.pid });
		let buf = "";
		let raw = "";
		let reply = "";
		let err = "";
		let status = "ok", assistantError = "", killTimer;
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
				assistantError = ["error", "aborted", "length"].includes(ev.message.stopReason) ? ev.message.errorMessage || `assistant stopped: ${ev.message.stopReason}` : "";
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
			killTimer = setTimeout(() => {
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
			clearTimeout(killTimer);
			clearInterval(poll);
			if (buf.trim()) onRecord(buf.trim());
			if (status === "ok" && (code !== 0 || assistantError)) status = "error";
			resolve({ status, reply: reply || raw.trim(), err: (err + assistantError).trim(), code });
		});
	});
}

// ---------- background pi that stays up: one `pi --mode rpc` per worktree slot ----------
// A fresh `pi` per turn loads every extension and connects every MCP server again (some start a browser each);
// with many items at once that is what swamps the machine. One process per slot serves all its items and turns,
// switching sessions instead of restarting. MCP servers stay off in workers unless workerMcp is true.

export function workerArgs(c, repo) {
	const args = ["--mode", "rpc", "--session-dir", join(repo, DIR, "sessions")];
	if (c.model) args.push("--model", c.model);
	if (c.thinking) args.push("--thinking", c.thinking);
	if (c.workerMcp !== true) args.push("--no-mcp");
	return args;
}

const UI_DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** Starts one RPC pi and waits until it answers. Resolves the worker handle or throws. */
export async function startRpcWorker({ pi, args, cwd, env }) {
	const child = spawn(pi, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	const w = { child, pid: child.pid, listeners: new Set(), pending: new Map(), stderr: "", served: 0, sessionId: undefined, thinking: undefined, dead: false };
	let next = 0, buf = "";
	w.exited = new Promise((resolve) => {
		child.on("close", (code) => { w.dead = true; w.code = code; for (const p of w.pending.values()) p.reject(new Error(`pi exited (code ${code}): ${tail(w.stderr, 3).replace(/\n/g, " ")}`)); w.pending.clear(); resolve(code); });
		child.on("error", (e) => { w.stderr += String(e); });
	});
	child.stdin.on("error", () => {});
	const send = (record) => { if (!w.dead) child.stdin.write(`${JSON.stringify(record)}\n`); };
	const onRecord = (line) => {
		let ev;
		try { ev = JSON.parse(line); } catch { return; }
		if (ev.type === "response" && ev.id && w.pending.has(ev.id)) {
			const p = w.pending.get(ev.id);
			w.pending.delete(ev.id);
			return ev.success === false ? p.reject(new Error(ev.error || `${ev.command} failed`)) : p.resolve(ev.data ?? {});
		}
		// nobody can answer an extension's dialog in an unattended run
		if (ev.type === "extension_ui_request") return UI_DIALOGS.has(ev.method) ? send({ type: "extension_ui_response", id: ev.id, cancelled: true }) : undefined;
		for (const l of w.listeners) l(ev);
	};
	// split on LF only: JSON strings may contain U+2028/U+2029
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (line.trim()) onRecord(line);
		}
	});
	child.stderr.on("data", (d) => { w.stderr = (w.stderr + d).slice(-20_000); });
	w.alive = () => !w.dead && pidAlive(w.pid);
	w.request = (type, fields = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
		if (w.dead) return reject(new Error(`pi is not running: ${tail(w.stderr, 3).replace(/\n/g, " ")}`));
		const id = `r${++next}`;
		const timer = setTimeout(() => { w.pending.delete(id); reject(new Error(`pi did not answer ${type} within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
		w.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
		send({ id, type, ...fields });
	});
	w.close = async () => {
		if (w.dead) return;
		try { child.stdin.end(); } catch {} // orderly shutdown
		const gone = await Promise.race([w.exited.then(() => true), sleep(5000).then(() => false)]);
		if (!gone) { try { process.kill(-w.pid, "SIGTERM"); } catch {} }
		if (!gone && !(await Promise.race([w.exited.then(() => true), sleep(5000).then(() => false)]))) { try { process.kill(-w.pid, "SIGKILL"); } catch {} }
	};
	try { await w.request("get_state", {}, 120_000); }
	catch (e) { await w.close(); throw new Error(`could not start pi in RPC mode: ${e.message}`); }
	return w;
}

/** A session file that only names its working folder: switching an RPC pi to it runs that session's tools there,
 *  so one process can serve every worktree. */
export function newSessionFile(repo, id, cwd) {
	const dir = join(repo, DIR, "sessions");
	mkdirSync(dir, { recursive: true });
	const at = new Date().toISOString();
	const file = join(dir, `${at.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd })}\n`);
	return file;
}

/** At most `max` RPC pi processes for the whole run, shared by all worktrees. Turns are already capped at `parallel`
 *  by the session gate, so an idle process is always there or may be started. */
async function rpcAcquire(ctx, c, ref) {
	const pool = ctx.rpcPool;
	const model = c.model || "";
	// Everything up to marking a process busy or reserving a start happens without an await, so concurrent turns
	// can neither share a process nor start more than `max`.
	const stale = pool.workers.filter((w) => !w.busy && (!w.alive() || w.served >= (c.workerRecycle ?? 20))); // dead, or served enough: a fresh process bounds slow leaks
	pool.workers = pool.workers.filter((w) => !stale.includes(w));
	const idle = pool.workers.filter((w) => !w.busy);
	let w = idle.find((x) => x.sessionId === ref.id && x.model === model) ?? idle.find((x) => x.model === model);
	if (w) { w.busy = true; await Promise.all(stale.map((x) => x.close())); return w; }
	const evict = pool.workers.length + (pool.starting ?? 0) >= pool.max && idle.length ? idle[0] : undefined; // an idle process on another model makes room
	if (evict) pool.workers = pool.workers.filter((x) => x !== evict);
	pool.starting = (pool.starting ?? 0) + 1;
	try {
		await Promise.all([...stale, ...(evict ? [evict] : [])].map((x) => x.close()));
		w = await startRpcWorker({ pi: ctx.pi, args: workerArgs(c, ctx.repo), cwd: ctx.repo, env: ctx.env });
	} finally { pool.starting--; }
	w.model = model;
	w.thinking = c.thinking || undefined;
	w.busy = true;
	pool.workers.push(w);
	return w;
}

/** Same contract as piTurn, on a long-lived RPC pi from the run's pool. ref.id/ref.file name the item's session. */
async function rpcTurn(ctx, cwd, ref, name, prompt, minutes, onActivity = () => {}) {
	const { c, stopRequested } = ctx;
	if (!ctx.rpcPool) throw new Error("rpcTurn needs ctx.rpcPool");
	let w;
	try { w = await rpcAcquire(ctx, c, ref); }
	catch (e) { return { status: "error", reply: "", err: e.message, code: 1 }; }
	const drop = async () => { const i = ctx.rpcPool.workers.indexOf(w); if (i >= 0) ctx.rpcPool.workers.splice(i, 1); await w.close(); };
	ctx.onWorker?.({ rpcPid: w.pid });
	try {
		if (w.sessionId === undefined || w.sessionId !== ref.id) {
			ref.id ??= randomUUID();
			let file = ref.file ?? sessionFiles(ctx.repo, [ref.id])[ref.id];
			const fresh = !file || !existsSync(file);
			if (fresh) file = newSessionFile(ctx.repo, ref.id, cwd);
			const sw = await w.request("switch_session", { sessionPath: file });
			if (sw?.cancelled) throw new Error("an extension cancelled the session switch");
			w.sessionId = ref.id;
			ref.file = file;
			w.thinking = undefined; // a resumed session restores its own level
			if (fresh) { w.served++; await w.request("set_session_name", { name }); }
			ctx.onWorker?.({ sessionId: ref.id, rpcPid: w.pid });
		}
		if (c.thinking && w.thinking !== c.thinking) { await w.request("set_thinking_level", { level: c.thinking }); w.thinking = c.thinking; }
	} catch (e) {
		await drop();
		return { status: "error", reply: "", err: `pi (rpc): ${e.message}`, code: 1 };
	}
	return new Promise((resolve) => {
		let reply = "", assistantError = "", status = "ok", done = false, killTimer;
		const finish = (extra = "") => {
			if (done) return;
			done = true;
			clearTimeout(timer); clearTimeout(killTimer); clearInterval(poll);
			w.listeners.delete(onEvent);
			w.busy = false;
			if (ctx.rpcPool.workers.length > ctx.rpcPool.max) drop(); // parallel was lowered: one process fewer
			if (status === "ok" && assistantError) status = "error";
			resolve({ status, reply, err: `${assistantError}${extra}`.trim(), code: status === "error" ? 1 : 0 });
		};
		const onEvent = (ev) => {
			if (ev.type === "tool_execution_start") onActivity(describeTool(ev.toolName, ev.args));
			else if (ev.type === "tool_execution_end" && ev.isError) onActivity(`${ev.toolName} failed`);
			else if (ev.type === "turn_start") onActivity("thinking");
			else if (ev.type === "compaction_start") onActivity("compacting context");
			else if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const t = textOf(ev.message);
				if (t) reply = t;
				assistantError = ["error", "aborted", "length"].includes(ev.message.stopReason) ? ev.message.errorMessage || `assistant stopped: ${ev.message.stopReason}` : "";
			} else if (ev.type === "agent_settled") finish();
		};
		w.listeners.add(onEvent);
		const kill = (why) => {
			if (status !== "ok" || done) return;
			status = why;
			w.request("abort", {}, 15_000).catch(() => {});
			// an abort that does not settle: stop the process (the pool starts another one)
			killTimer = setTimeout(async () => { await drop(); finish(); }, 30_000);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => kill("timeout"), minutes * 60_000);
		const poll = setInterval(() => stopRequested() && kill("stopped"), 3_000);
		w.exited.then(() => { const i = ctx.rpcPool.workers.indexOf(w); if (i >= 0) ctx.rpcPool.workers.splice(i, 1); if (status === "ok") status = "error"; finish(`pi exited (code ${w.code}) ${tail(w.stderr, 5)}`); });
		w.request("prompt", { message: prompt }, 120_000).then(
			(d) => { if (d?.disposition === "handled") finish(); },
			(e) => { if (status === "ok") status = "error"; finish(e.message); },
		);
	});
}

export async function closeRpcPool(ctx) {
	const all = ctx.rpcPool?.workers.splice(0) ?? [];
	await Promise.all(all.map((w) => w.close().catch(() => {})));
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
		if (!res.ok || json?.error || json?.success === false) throw new Error(`Pi Web ${path}: ${res.status} ${json?.error ?? ""}`.trim());
		return json;
	};
	return {
		available: () => call("GET", "/api/agent/running", undefined, 3000).then(() => true, () => false),
		running: async (id) => {
			const snap = await call("GET", "/api/agent/running", undefined, 15_000);
			const active = [...(snap.runningSessionIds ?? []), ...(snap.subagentsActiveSessionIds ?? [])];
			if (id && !active.includes(id) && active.length) {
				const { sessions } = await call("GET", "/api/sessions?summary=1");
				const family = new Set([id]);
				for (let grew = true; grew;) {
					grew = false;
					for (const s of sessions) if (s.relation?.kind === "subagent" && family.has(s.relation.parentSessionId) && !family.has(s.id)) {
						family.add(s.id); grew = true;
					}
				}
				if (active.some((sid) => family.has(sid))) snap.subagentsActiveSessionIds = [...(snap.subagentsActiveSessionIds ?? []), id];
			}
			return snap;
		},
		create: (body) => call("POST", "/api/agent/new", body, 300_000),
		send: (id, body) => call("POST", `/api/agent/${encodeURIComponent(id)}`, body, 120_000),
		history: async (id) => {
			let before = "";
			while (true) {
				const response = await call("GET", `/api/sessions/${encodeURIComponent(id)}${before ? "/context" : ""}?tree=summary&tail=1&deferMedia=1&deferThinking=1${before ? `&before=${encodeURIComponent(before)}` : ""}`);
				if (response.context.messages.some((m) => m.role === "assistant") || !response.context.hasMore) return response;
				before = response.context.oldestEntryId;
			}
		},
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
	let previousAssistantId;
	let sent = false;
	try {
		if (!ref.id) {
			const r = await web.create({
				cwd,
				type: "ensure_session",
				...(ctx.manager ? { toolNames: [] } : {}),
				...(provider && modelId ? { provider, modelId } : {}),
				...(c.thinking ? { thinkingLevel: c.thinking } : {}),
			});
			ref.id = r.sessionId;
			ctx.onWorker?.({ sessionId: ref.id, web: true, webUrl: c.piWebUrl || ctx.c?.piWebUrl });
			await web.send(ref.id, { type: "set_session_name", name }).catch(() => {});
		}
		const { context } = await web.history(ref.id);
		previousAssistantId = context.entryIds[context.messages.findLastIndex((m) => m.role === "assistant")];
		sent = true; // from here on the session may be working even if the request itself fails
		await web.send(ref.id, { type: "prompt", message: prompt });
	} catch (e) {
		// nothing was asked of the session yet: an ordinary (retryable) failure, not an uncertain worker
		return { status: "error", reply: "", err: `Pi Web: ${String(e?.message ?? e)}`, code: -1, quiescent: !sent };
	}
	onActivity("thinking");
	let sessionFile;
	let status = "ok";
	let awaitingSince = 0;
	let notRunning = 0;
	let unreachableSince = 0;
	let lastSeen = "";
	while (true) {
		await new Promise((r) => setTimeout(r, 3000));
		let snap;
		try {
			snap = await web.running(ref.id);
			unreachableSince = 0;
		} catch {
			unreachableSince ||= Date.now();
			// Pi Web restarting is normal; gone for 5 minutes means this worker cannot be followed any more
			if (!stopRequested() && Date.now() <= deadline && Date.now() - unreachableSince < 5 * 60_000) continue;
			await web.send(ref.id, { type: "abort" }).catch(() => {});
			return { status: "error", reply: "", err: "Pi Web unreachable; worker termination is unconfirmed", code: -1, quiescent: false };
		}
		const running = [...(snap.runningSessionIds ?? []), ...(snap.subagentsActiveSessionIds ?? [])].includes(ref.id);
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
			let quiescent = false;
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 3000));
				const s2 = await web.running(ref.id).catch(() => null);
				if (s2 && ![...(s2.runningSessionIds ?? []), ...(s2.subagentsActiveSessionIds ?? [])].includes(ref.id)) { quiescent = true; break; }
			}
			if (!quiescent) return { status: "error", reply: "", err: "worker did not confirm termination", code: -1, quiescent: false };
			if (why === "error") return { status, reply: "", err: "the agent waited for a person's answer for 2 minutes", code: -1 };
			break;
		}
	}
	try {
		const { context } = await web.history(ref.id);
		const index = context.messages.findLastIndex((m) => m.role === "assistant");
		const last = context.messages[index];
		if (!last || context.entryIds[index] === previousAssistantId) return { status: "error", reply: "", err: "Pi Web returned no new assistant result", code: -1 };
		const err = last.stopReason === "stop" ? "" : last.errorMessage || `assistant stopped: ${last.stopReason}`;
		return { status: status === "ok" && err ? "error" : status, reply: textOf(last), err, code: err ? -1 : 0 };
	} catch (e) { return { status: "error", reply: "", err: String(e), code: -1 }; }
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
			const info = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-check", "cli.json"), "utf8"));
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
	const waiting = reply.match(/^\s*WAITING:\s*(.+)$/m);
	if (waiting) return `agent: WAITING: ${waiting[1].slice(0, 300)}`;
	const blocked = reply.match(/^\s*BLOCKED:\s*(.+)$/m);
	if (blocked) return `agent: BLOCKED: ${blocked[1].slice(0, 300)}`;
	const m = await measure(cwd, base, c.allowedPaths, c.generatedPaths ?? []);
	if (item.readonly) return m.files.length ? `read-only item changed files: ${m.files.slice(0, 5).join(", ")}` : undefined;
	// passing checks are not the result: what it declares it produces must exist (a no-change [check] included)
	const missingOut = (item.produces ?? []).filter((p) => !existsSync(join(cwd, p)));
	if (missingOut.length) return `required output missing: ${missingOut.join(", ")} (declared with [produces: …]; later items read it)`;
	// an item whose result another item already delivered passes on the same checks, instead of failing its dependents
	const already = /^\s*ALREADY DONE\b/im.test(reply);
	if (m.files.length === 0) return item.check || item.repaired || already ? runChecks(c, cwd) : "no changes were made";
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
	const tip = (await git(repo, "rev-parse", ctx.branch)).out.trim();
	const dirty = !(await treeIsClean(wt));
	if (dirty || (await git(wt, "merge-base", "--is-ancestor", "HEAD", tip)).code !== 0) {
		// leftovers from an interrupted run: keep them on a branch instead of refusing to start
		if (c.autoReconcile === false) throw new Error(`worktree ${wt} has unpreserved changes or commits; refusing to reset it`);
		await git(wt, "rebase", "--abort");
		const kept = await preserveWork(repo, wt, `queue-failed/w${slot}-leftover-${Date.now()}`, `queue LEFTOVER w${slot}`, dirty);
		if (kept.error) throw new Error(`worktree ${wt} has changes that could not be preserved: ${kept.error}`);
		log(`RECONCILED w${slot} · leftover changes kept on ${kept.name}`);
	}
	const checkout = await git(wt, "checkout", "--detach", tip);
	if (checkout.code !== 0) throw new Error(checkout.out);
	// Ignored project-local plugins are absent in fresh worktrees. Reuse the installed extension, not its state/settings.
	const bridge = ".pi/extensions/pi-flow-check", link = join(wt, bridge);
	const broker = checkBroker({}), packageDir = broker && realpathSync(dirname(broker.cli));
	if (packageDir && c.checkBroker !== false && !existsSync(join(packageDir, "extension.ts"))) throw new Error(`pi-check extension missing at ${packageDir}; repair its installation before starting workers`);
	const existing = lstatSync(link, { throwIfNoEntry: false });
	if (existing && (!existing.isSymbolicLink() || readlinkSync(link) !== packageDir)) throw new Error(`reserved pi-flow plugin bridge ${link} belongs to something else; refusing to overwrite it`);
	if (existing && c.checkBroker === false) rmSync(link);
	if (packageDir && c.checkBroker !== false) {
		await ensureDir(wt, [bridge]);
		mkdirSync(dirname(link), { recursive: true });
		if (!existing) symlinkSync(packageDir, link, "dir");
	}
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
	for (let i = 0; ctx.web && i < webIds.length; i += 500) {
		const batch = webIds.slice(i, i + 500);
		try {
			if (mode === "archive") {
				await ctx.web.ui({ action: "set", ids: batch, archived: true });
				for (const id of batch) sessions[id].archived = true;
				n += batch.length;
			} else {
				const r = await ctx.web.del(batch);
				for (const id of [...(r.deleted ?? []), ...(r.missing ?? [])]) if (sessions[id]) sessions[id].deleted = true;
				n += (r.deleted ?? []).filter((id) => batch.includes(id)).length;
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
	item = { ...item, repaired: (state.fixes?.[item.key] ?? []).some((line) => parseQueue(line).some((fix) => fix.id.startsWith(`${item.id}-repair`) && state.done[fix.key])) };
	const itemChecks = loadJson(join(repo, ".tasks", ctx.c.task, "task.json"), {}).itemChecks;
	let c = itemConfig({ ...ctx.c, itemChecks }, item); // keep worker, judge and rebase checks identical
	if (state.limits?.[item.key]) c = { ...c, ...state.limits[item.key] }; // raised by you or the manager
	if (state.boost?.[item.key]) c = boosted(c, state.boost[item.key]);
	if (state.scope?.[item.key]) c = { ...c, allowedPaths: [...new Set([...c.allowedPaths, ...state.scope[item.key]])] }; // widened earlier
	// Pi Web went away (restart, laptop lid, update): new items run as background pi instead of failing one by one
	if (ctx.web && ctx.c.runIn !== "web" && !(await ctx.web.available())) {
		ctx.web = null;
		log("Pi Web is not reachable any more · new items run as background pi");
	}
	const started = Date.now();
	const solo = wt === repo; // working directly in the repo folder
	let base = (await git(repo, "rev-parse", branch)).out.trim();
	if (!(await treeIsClean(wt))) throw new Error(`worktree ${wt} has unpreserved changes`);
	if (solo) await git(wt, "reset", "--hard", base);
	else await git(wt, "checkout", "--detach", "--force", base);
	await git(wt, "clean", "-fd");

	const cliId = randomUUID();
	const web = ctx.web; // one backend for the whole item, even if Pi Web goes away meanwhile
	const ref = { id: web ? undefined : cliId, web };
	const rpc = !web && ctx.c.workerMode !== "json";
	const turn = async (prompt, minutes, onAct, phase = "coding", tref = ref, tname = name) => {
		const worker = { ...ctx, web, c, onWorker: (identity) => { if (tref === ref) Object.assign(live, identity); else Object.assign(live, Object.fromEntries(Object.entries(identity).filter(([k]) => k !== "sessionId"))); save(); } };
		const giveUpAt = Date.now() + (c.outageMinutes ?? 180) * 60_000;
		for (let attempt = 0; ; attempt++) {
			// a provider outage seen by any worker holds every worker back, instead of burning each item's retries
			while (Date.now() < (ctx.outage?.until ?? 0) && !ctx.stopRequested()) await sleep(Math.min(5000, ctx.outage.until - Date.now()));
			if (!(await ctx.acquirePhase(slot, phase))) return { status: "stopped", reply: "", err: "" };
			// never more agent sessions at once than `parallel`, coding and verification together
			const releaseSession = await (ctx.sessionGate?.() ?? (() => {}));
			const toolsBefore = live.tools, startedAt = Date.now();
			let result;
			try { result = await (web ? webTurn(worker, wt, tref, tname, prompt, minutes, onAct) : rpc ? rpcTurn(worker, wt, tref, tname, prompt, minutes, onAct) : piTurn(worker, wt, tref.id, tname, prompt, minutes, onAct)); }
			finally { releaseSession(); }
			if (result.quiescent === false) throw new Error(`${result.err}; worktree quarantined`);
			// An error before the agent did anything (rate limit, overloaded provider, login expired, network) says nothing
			// about the item: wait and ask again in the same session.
			const idle = result.status === "error" && live.tools === toolsBefore && Date.now() - startedAt < 5 * 60_000;
			if (!idle || ctx.stopRequested() || Date.now() >= giveUpAt) {
				if (result.status === "ok" && ctx.outage) ctx.outage.streak = 0;
				return result;
			}
			ctx.outage ??= { until: 0, streak: 0 };
			const pauses = Array.isArray(c.outagePauses) && c.outagePauses.length ? c.outagePauses : [30, 120, 300, 600, 1200, 1800]; // seconds
			const pause = pauses[Math.min(attempt, pauses.length - 1)] * 1000;
			ctx.outage.until = Math.max(ctx.outage.until, Date.now() + pause);
			log(`PROVIDER ${item.id} · ${firstLine(result.err || result.reply).slice(0, 140) || "session error"} · no work was done; all workers wait ${pause >= 60_000 ? `${Math.round(pause / 60_000)} min` : `${Math.round(pause / 1000)} s`} and ask again`);
			setDoing(`waiting out a provider/session error (attempt ${attempt + 2})`);
			save();
		}
	};
	const sessionId = cliId;
	const name = `queue ${item.id}: ${item.title}`.slice(0, 80);
	const live = { id: item.id, key: item.key, title: item.title, model: c.model, thinking: c.thinking, sessionId, worktree: wt, startedAt: new Date().toISOString(), doing: "starting", phase: item.check ? "verification" : "coding", tools: 0, since: Date.now() };
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

	// what items this one depends on reported (read-only audits) or could not deliver (released failures)
	const deps = allItems(ctx.queueText?.() ?? "", state).filter((o) => (item.after ?? []).some((d) => o.id === d || (o.child && o.id.startsWith(d))));
	const reports = deps.filter((o) => o.readonly && existsSync(join(repo, DIR, "reports", `${o.id}.md`))).map((o) => join(repo, DIR, "reports", `${o.id}.md`));
	const released = deps.filter((o) => state.released?.[o.key]);
	const depNote = `${reports.length ? `\n\nFindings of the read-only items you depend on (read them first): ${reports.join(", ")}` : ""}${released.length ? `\n\nThese prerequisites FAILED and will not be retried; their work is NOT in the code: ${released.map((o) => `${o.id} (${String(state.released[o.key]).slice(0, 120)})`).join("; ")}. Do what you can without them. If your item truly cannot be done without one, reply BLOCKED: needs <id>.` : ""}${item.readonly ? "\n\nThis item is READ-ONLY: do not change any file. Investigate and reply DONE followed by your findings in full (they are saved and given to the items that depend on this one)." : ""}`;
	const failedDeps = item.check ? allItems(ctx.queueText?.() ?? "", state).filter((o) => state.failed[o.key] && ((item.after ?? []).includes("*") || (item.after ?? []).some((d) => o.id === d || o.id.startsWith(d)))) : [];
	const failedNote = failedDeps.length ? `\n\nThese covered items FAILED; their work is not in the code. Do not report GAPs for them (the queue tracks them): ${failedDeps.map((o) => `${o.id} (${String(state.failed[o.key]).slice(0, 120)})`).join("; ")}` : "";
	const prior = join(repo, DIR, "notes", `${item.repairParent?.id ?? item.id}.md`);
	const previous = existsSync(prior) ? `\n\nPrevious attempt and manager diagnosis (evidence, not permission to expand scope):\n${readFileSync(prior, "utf8").slice(-12000)}` : "";
	// What its prerequisites declared they produce must be in this checkout before a worker is spent on it.
	const missingInputs = deps.filter((o) => state.done[o.key] && !state.released?.[o.key]).flatMap((o) => (o.produces ?? []).filter((p) => !existsSync(join(wt, p))).map((p) => `${p} (from ${o.id})`));
	let t = missingInputs.length ? { status: "ok", reply: "", err: "" } : await turn(itemPrompt(c, item) + depNote + failedNote + previous, c.itemMinutes, onActivity, item.check ? "verification" : "coding");
	if (ref.id) {
		state.sessions = { ...(state.sessions ?? {}), [ref.id]: { item: item.id, status: "running", web: !!web } };
		save();
	}
	let redone = false;
	let bypassed = false;
	let confirmed = false;
	const raise = (why, limits) => {
		c = { ...c, ...limits };
		log(`LIMITS RAISED ${item.id} · ${why} · now ${c.maxFilesGrowing} files / ${c.maxNetLines} lines`);
	};
	const verdict = async () => {
		if (!(await ctx.acquirePhase(slot, "verification"))) return "stopped by request";
		if (t.status === "stopped") return "stopped by request";
		if (t.status === "timeout") return `timed out after ${c.itemMinutes} min`;
		if (t.status === "error") return `pi exited with an error (code ${t.code}): ${firstLine(t.err || t.reply).slice(0, 200)}`;
		if (!bypassed && (await bypassAsked(ctx, ref))) {
			bypassed = true;
			raise("you asked for it in the session", UNLIMITED);
		}
		// a DONE that admits a shortfall gets one turn to finish or say NEEDS/BLOCKED, instead of passing on green checks
		if (!item.check && !confirmed && /^\s*DONE\b/m.test(t.reply) && !/DONE:\s*CONFIRMED/i.test(t.reply) && SHORTFALL.test(t.reply.replace(/^\s*DONE\b.*$/m, ""))) {
			confirmed = true;
			log(`CONFIRM ${item.id} · DONE reply admits a shortfall · asked to finish it or say NEEDS/BLOCKED`);
			setDoing("confirming that Done when is fully met");
			save();
			t = await turn(confirmPrompt(c, item, t.reply), Math.max(10, Math.round(c.itemMinutes / 2)), onActivity);
			return verdict();
		}
		setDoing("runner: checking scope, size and checks");
		save();
		return judge(c, wt, base, t.reply, item);
	};
	// Out of time with work in progress: one shorter turn in the same session to finish, instead of losing the work.
	if (t.status === "timeout" && !ctx.stopRequested() && live.tools > 0) {
		log(`OVERTIME ${item.id} · ${c.itemMinutes} min were not enough · one more turn to finish up`);
		setDoing("finishing up after the time limit");
		t = await turn(overtimePrompt(c), Math.max(10, Math.round(c.itemMinutes / 2)), onActivity, item.check ? "verification" : "coding");
	}
	let reason = missingInputs.length ? `needs you: required input missing: ${missingInputs.join(", ")} · the item that produces it passed but it is not in the code (git-ignored or removed later)` : await verdict();
	// the next attempt (yours or the automatic one) gets more time
	if (/^timed out after/.test(reason ?? "")) state.limits = { ...(state.limits ?? {}), [item.key]: { ...(state.limits?.[item.key] ?? {}), itemMinutes: Math.min(240, Math.round(c.itemMinutes * 1.5)) } };
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
	// It needs a few files outside the allowed paths. With full autonomy they are allowed for this item (logged for
	// review) and the work is kept, instead of throwing the change away and failing.
	const canWiden = ctx.c.autonomy === "full" && c.widenScope !== false && !item.readonly && !item.repairParent;
	const widen = (paths, why) => {
		state.scope = { ...(state.scope ?? {}), [item.key]: [...new Set([...(state.scope?.[item.key] ?? []), ...paths])] };
		c = { ...c, allowedPaths: [...new Set([...c.allowedPaths, ...paths])] };
		log(`SCOPE ${item.id} · also allowed: ${paths.join(", ")} · ${firstLine(why).slice(0, 100)}`);
		try { appendFileSync(join(repo, DIR, "decisions.md"), `\n## ${item.id} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}\nScope widened for this item: ${paths.join(", ")}\nBecause: ${firstLine(why).slice(0, 300)}\n`); } catch {}
		save();
	};
	const scopeNeeded = async (why) => {
		if (!canWiden || !why) return undefined;
		let paths = [];
		if (/^files outside /.test(why)) paths = (await measure(wt, base, c.allowedPaths, c.generatedPaths ?? [])).outside;
		else if (/^agent: BLOCKED/.test(why) && SCOPE_REASON.test(why) && !/^agent: BLOCKED: (decision|env)\b|\b(frozen|forbidden|protected|policy)\b/i.test(why)) {
			// An item may stop at its [areas] even when the task already allows the file.
			if (why.length >= "agent: BLOCKED: ".length + 300) return undefined; // judge may have truncated the path
			paths = scopeFiles(why).filter((p) => !pathAllowed(p, c.allowedPaths) || (item.areas?.length && !pathAllowed(p, item.areas) && !state.scope?.[item.key]?.includes(p)));
		}
		paths = [...new Set(paths)];
		if (!paths.length || paths.some((p) => !ordinaryScopeFile(wt, p)) || (state.scope?.[item.key]?.length ?? 0) + paths.length > (c.widenMax ?? 12)) return undefined;
		return paths;
	};
	for (let round = 0; reason && t.status === "ok" && round < 2 && !ctx.stopRequested(); round++) {
		const paths = await scopeNeeded(reason);
		if (!paths) break;
		widen(paths, reason);
		if (/^files outside /.test(reason)) { reason = await verdict(); continue; } // the change is already there: judge it again
		setDoing("continuing with the wider scope");
		t = await turn(scopePrompt(c, paths), c.itemMinutes, onActivity);
		reason = await verdict();
	}
	for (let round = 0; reason && t.status === "ok" && round < c.fixRounds; round++) {
		// A size stop is never "fixed" by asking the agent to fit under the limit: that is how a worker
		// drops the real change, keeps the old implementation and reports DONE. Too big stays too big.
		if (/^agent: (BLOCKED|GAPS|WAITING)|^needs you/.test(reason) || isSizeStop(reason) || reason === "no changes were made" || ctx.stopRequested()) break;
		setDoing(`fixing: ${firstLine(reason).slice(0, 80)}`);
		t = await turn(fixPrompt(c, reason), Math.max(10, Math.round(c.itemMinutes / 2)), onActivity);
		reason = await verdict();
	}

	let kind = reason ? "fail" : "pass";
	let splitLines = [];
	let fixLines = [];
	const sessionTags = `${c.model ? ` [model: ${c.model}]` : ""}${c.thinking ? ` [thinking: ${c.thinking}]` : ""}`;
	// Growth is reserved before any asynchronous work, so parallel workers cannot spend the same budget twice.
	// Keyed by item, so a crashed item never leaks its reservation into the rest of the run.
	ctx.growthReserved ??= new Map();
	const growthLeft = () => growthBudget(ctx.c, ctx.plannedCount?.() ?? 0) - growthUsed(state) - [...ctx.growthReserved.values()].reduce((a, b) => a + b, 0);
	const reserve = (n) => ctx.growthReserved.set(item.key, (ctx.growthReserved.get(item.key) ?? 0) + n);
	const release = () => ctx.growthReserved.delete(item.key);
	// a check found production gaps: queue fix items before it and check again after them
	if (reason?.startsWith("agent: GAPS") && item.check) {
		// a round with findings left over (no room for them) does not count: they were never tried
		const round = (state.gapRound?.[item.key] ?? 0) + (state.gapBacklog?.[item.key] ? 0 : 1);
		const gaps = t.reply.split("\n").map((l) => l.match(/^\s*GAP:\s*(.+?)\s*$/)?.[1]).filter(Boolean).slice(0, 12);
		const room = Math.min(Math.max(1, Math.floor(c.maxGapItems ?? 3)), growthLeft());
		if (c.autoFix !== false && round <= (c.gapRounds ?? 2) && room > 0) {
			const base0 = (state.fixes?.[item.key] ?? []).length;
			const plain = { ...ctx.c, itemChecks: c.itemChecks }; // the task's limits, not this check's
			const plan = planGapJobs(gaps, { room, maxFiles: plain.maxFilesGrowing ?? 5, allowedPaths: c.allowedPaths });
			const all = ctx.currentItems?.() ?? [];
			const admitted = [], rejected = [...plan.rejected.map((r) => `${r.gap.slice(0, 140)} — ${r.why}`)];
			for (const g of plan.jobs) {
				const line = `- [ ] ${item.id}-fix${base0 + admitted.length + 1} — ${g}${sessionTags}`;
				const why = admissionProblem(line, plain, [...all, ...admitted.flatMap((l) => parseQueue(l))]);
				if (why) rejected.push(`${g.slice(0, 140)} — ${why}`);
				else admitted.push(line);
			}
			for (const r of rejected) log(`REJECTED ${item.id} finding · ${r}`);
			if (rejected.length) appendFileSync(join(repo, DIR, "notes", `${item.id}.md`), `\n\n## Findings not queued (round ${round})\n\n${rejected.map((r) => `- ${r}`).join("\n")}\n`);
			if (admitted.length) {
				reserve(admitted.length);
				fixLines = admitted;
				kind = "gaps";
				state.gapRound = { ...(state.gapRound ?? {}), [item.key]: round };
				state.gapBacklog = { ...(state.gapBacklog ?? {}), [item.key]: plan.leftover.length };
				if (plan.leftover.length) log(`GAPS ${item.id} · ${plan.leftover.length} more finding(s) wait for the next round (no room now)`);
			} else reason = `needs you: ${item.id}'s findings could not be queued: ${rejected.map((r) => r.slice(0, 200)).join(" | ")}`;
		} else reason = room > 0 ? `gaps remain after ${round - 1} fix round(s): ${gaps.map((g) => g.slice(0, 120)).join(" | ")}` : `needs you: the queue's growth budget is used up (${growthUsed(state)} derived items); gaps: ${gaps.map((g) => g.slice(0, 100)).join(" | ")}`;
	}
	// WAITING: <ids> — it needs another item's work first: run it again after those items (no failure, no split)
	if (reason?.startsWith("agent: WAITING")) {
		const all = ctx.currentItems?.() ?? [];
		const named = [...new Set((reason.match(/\b[A-Z]+\d+[A-Za-z0-9-]*\b/g) ?? []).filter((id) => id !== item.id))];
		const open = named.filter((id) => all.some((i) => (i.id === id || (i.child && i.id.startsWith(id) && /^[a-z]$/.test(i.id.slice(id.length)))) && !state.done[i.key] && !state.failed[i.key]));
		const waits = (state.waits?.[item.key] ?? 0) + 1;
		let ok = open.length > 0 && waits <= (c.maxWaits ?? 3);
		if (ok) {
			const waitFor = { ...(state.waitFor ?? {}), [item.key]: [...new Set([...(state.waitFor?.[item.key] ?? []), ...open])] };
			try { dependencyGraph(allItems(ctx.queueText?.() ?? "", { ...state, waitFor })); }
			catch { ok = false; } // waiting would close a cycle: treat it as blocked
			if (ok) {
				state.waitFor = waitFor;
				state.waits = { ...(state.waits ?? {}), [item.key]: waits };
				kind = "waiting";
			}
		}
		if (!ok) reason = `agent: BLOCKED: ${reason.slice("agent: WAITING: ".length)}${named.length && !open.length ? " (the items it waits for are already done or unknown)" : ""}`;
	}
	// Paths it names that do not exist: which files have that name, which open items name them (and so provide them).
	const isOpen = (o) => o.key !== item.key && !state.done[o.key] && !state.failed[o.key];
	const graphOk = (patch) => { try { dependencyGraph(allItems(ctx.queueText?.() ?? "", { ...state, ...patch })); return true; } catch { return false; } };
	const missingPaths = async (why) => {
		const all = ctx.currentItems?.() ?? [];
		// files under its own areas are what the item itself creates: not missing
		const named = mentionedPaths(`${item.line}\n${why}\n${t.reply}`).filter((p) => widenable(p) && !existsSync(join(wt, p)) && !pathAllowed(p, item.areas ?? [])).slice(0, 20);
		if (!named.length) return [];
		const files = (await git(wt, "ls-files")).out.split("\n").filter(Boolean);
		return named.map((p) => {
			const name = basename(p);
			return { path: p, hits: files.filter((f) => f === name || f.endsWith(`/${name}`)).slice(0, 5), providers: all.filter((o) => isOpen(o) && o.line.includes(p)).map((o) => o.id) };
		});
	};
	// It lacks files that items which have not run yet name: wait for exactly those, now (no session, no deferral to the end).
	if (kind === "fail" && reason?.startsWith("agent: BLOCKED") && !/^agent: BLOCKED: (decision|env)\b/i.test(reason)) {
		const missing = await missingPaths(reason);
		const providers = [...new Set(missing.flatMap((m) => m.providers))];
		const waitFor = { ...(state.waitFor ?? {}), [item.key]: [...new Set([...(state.waitFor?.[item.key] ?? []), ...providers])] };
		if (missing.length && missing.every((m) => m.providers.length && !m.hits.length) && (state.waits?.[item.key] ?? 0) < (c.maxWaits ?? 3) && graphOk({ waitFor })) {
			state.waitFor = waitFor;
			state.waits = { ...(state.waits ?? {}), [item.key]: (state.waits?.[item.key] ?? 0) + 1 };
			kind = "waiting";
			log(`REWORK ${item.id} · ${firstLine(reason).slice(0, 100)} → waits for ${providers.join(", ")} (they provide ${missing.map((m) => m.path).join(", ")})`);
		}
	}
	// BLOCKED while other work is still pending (often a prerequisite that has not run yet): try once more after it.
	// A decision only the user can make is not deferred: it goes straight to "needs you".
	const blockedOnly = reason?.startsWith("agent: BLOCKED") && !isSizeStop(reason) && !SCOPE_REASON.test(reason) && !/^agent: BLOCKED: decision\b/i.test(reason);
	if (kind === "fail" && blockedOnly && c.deferBlocked !== false && !state.deferred?.[item.key] && ctx.otherWorkPending?.(item)) kind = "deferred";
	// Split only what is genuinely too big after the last size level. BLOCKED items are never split:
	// splitting a blocked item multiplies the same blocker.
	if (kind === "fail" && reason && c.autoSplit !== false && !item.child && t.status === "ok" && !ctx.stopRequested() && isSizeStop(reason) && !reason.startsWith("agent: BLOCKED") && !SCOPE_REASON.test(reason)) {
		const allowed = Math.min(c.splitMax ?? 4, growthLeft() + 1); // parts beyond the first count as growth
		if (allowed < 2) reason = `needs you: too big for one session and the queue's growth budget is used up (${growthUsed(state)} derived items) · ${firstLine(reason)}`;
		else {
			reserve(allowed - 1);
			setDoing("asking the agent to split this item");
			save();
			const st = await turn(splitPrompt({ ...c, splitMax: allowed }, item, reason), 15, onActivity);
			const texts = String(st.reply)
				.split("\n")
				.map((l) => l.match(/^\s*ITEM:\s*(.+?)\s*$/)?.[1])
				.filter(Boolean);
			// Never keep only some of the parts: the parent counts as done when its parts are, so a dropped part is dropped work.
			if (st.status === "ok" && texts.length > allowed) reason = `needs you: too big for one session; the agent needs ${texts.length} parts but at most ${allowed} fit (splitMax / growth budget) · ${firstLine(reason)}`;
			else if (st.status === "ok" && texts.length >= 2) {
				const kid = (n) => `${item.id}${String.fromCharCode(96 + n)}`;
				const lines = texts.map(
					(txt, i) =>
						`- [ ] ${kid(i + 1)} — ${txt.replace(/\[after:\s*([^\]]+)\]/i, (_, deps) => `[after: ${deps.split(/[,\s]+/).filter(Boolean).map((d) => (/^\d+$/.test(d) ? kid(Number(d)) : d)).join(", ")}]`)}${sessionTags}`,
				);
				// every part must be runnable as written (all or nothing: a dropped part is dropped work)
				const others = (ctx.currentItems?.() ?? []).filter((o) => o.key !== item.key);
				const parts = lines.flatMap((l) => { try { return parseQueue(l); } catch { return []; } });
				const top = Math.max(c.maxFilesGrowing ?? 5, ...(c.escalate ?? []).map((l) => l.maxFilesGrowing ?? 0));
				const problems = lines.map((l) => admissionProblem(l, { ...ctx.c, itemChecks: c.itemChecks }, [...others, ...parts.filter((p) => !l.includes(`${p.id} —`))], { maxFiles: top })).filter(Boolean);
				if (problems.length) reason = `the split is not runnable as written: ${problems.join(" | ").slice(0, 600)} · ${firstLine(reason)}`;
				else { splitLines = lines; kind = "split"; }
			}
		}
	}
	let sha = "";
	let m;
	for (let attempt = 0; !reason && attempt < 2; attempt++) {
		if (ctx.stopRequested()) { reason = "stopped by request"; kind = "fail"; break; }
		m = await measure(wt, base, c.allowedPaths);
		if (m.files.length === 0) {
			sha = "checked"; // a [check] item that verified without changing anything: nothing to commit
			if (item.readonly) {
				// the findings are the result: keep them for dependents and the morning report
				mkdirSync(join(repo, DIR, "reports"), { recursive: true });
				writeFileSync(join(repo, DIR, "reports", `${item.id}.md`), `# ${item.id} — ${item.title}\n\n${String(t.reply).replace(/^\s*DONE\b[^\n]*\n?/, "").trim()}\n`);
			}
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
			// Rebase and re-check OUTSIDE the merge lock first, so one item's checks never hold up the others' merges.
			// Under the lock only a fast-forward is left, unless the branch moved again in between.
			let rebasedOn = base, early;
			for (let i = 0; !solo && i < 2 && !early; i++) {
				const tip = (await git(repo, "rev-parse", branch)).out.trim();
				if (tip === rebasedOn) break;
				setDoing("rebasing on items merged meanwhile");
				const rb = await git(wt, "rebase", tip);
				if (rb.code !== 0) { await git(wt, "rebase", "--abort"); early = { reason: "conflict with an item merged meanwhile", kind: "conflict" }; break; }
				const broke = await runChecks(c, wt);
				if (broke) { early = { reason: `breaks checks after merging with other items: ${firstLine(broke)}`, kind: "conflict" }; break; }
				rebasedOn = tip;
			}
			const r = early ?? (solo
				? { sha: (await git(repo, "rev-parse", "--short", "HEAD")).out.trim() } // already committed on the branch
				: await lock(async () => {
				setDoing("merging into the branch");
				save();
				const tip = (await git(repo, "rev-parse", branch)).out.trim();
				if (tip !== rebasedOn) {
					const rb = await git(wt, "rebase", tip);
					if (rb.code !== 0) {
						await git(wt, "rebase", "--abort");
						return { reason: "conflict with an item merged meanwhile", kind: "conflict" };
					}
					const broke = await runChecks(c, wt);
					if (broke) return { reason: `breaks checks after merging with other items: ${firstLine(broke)}`, kind: "conflict" };
				}
				if (ctx.stopRequested()) return { reason: "stopped by request", kind: "fail" };
				const head = (await git(wt, "rev-parse", "HEAD")).out.trim();
				const ff = await git(repo, "merge", "--ff-only", head);
				if (ff.code !== 0) return { reason: `could not fast-forward ${branch}: ${tail(ff.out, 3).replace(/\n/g, " ")}`, kind: "fail" };
				return { sha: (await git(repo, "rev-parse", "--short", "HEAD")).out.trim() };
			}));
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
			const archive = await git(repo, "branch", `queue-failed/${item.id}-${started}-redo`, (await git(wt, "rev-parse", "HEAD")).out.trim());
			if (archive.code !== 0) throw new Error(`failed to preserve conflicting work: ${archive.out}`);
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
	appendFileSync(
		join(repo, DIR, "notes", `${item.id}.md`),
		`\n\n# ${item.line}\n\nResult: ${reason ? `${kind.toUpperCase()} — ${reason}` : `PASS ${sha}`}\nSession: ${ref.id ?? sessionId}${web ? " (Pi Web)" : ""}\nWorktree: ${wt}\n\n## Agent's last reply\n\n${t.reply}\n${t.err ? `\n## stderr\n\n${t.err.slice(-4000)}\n` : ""}`,
	);

	let kept = "";
	if (reason) {
		await lock(async () => {
			const staged = await git(wt, "add", "-A");
			if (staged.code !== 0) throw new Error(`failed to preserve work: ${staged.out}`);
			const hasWork = (await git(wt, "rev-parse", "HEAD")).out.trim() !== base || !(await treeIsClean(wt));
			if (hasWork) {
				const preserved = await git(wt, "commit", "--no-verify", "--allow-empty", "-m", `queue FAILED ${item.id}: ${firstLine(reason)}`);
				if (preserved.code !== 0) throw new Error(`failed to preserve work: ${preserved.out}`);
				const backup = `queue-failed/${item.id}-${started}`;
				const archived = await git(repo, "branch", backup, (await git(wt, "rev-parse", "HEAD")).out.trim());
				if (archived.code !== 0) throw new Error(`failed to preserve work: ${archived.out}`);
				kept = ` · work kept on ${backup}`;
			}
		});
	}
	const resetWorktree = async () => {
		if (solo) await git(wt, "reset", "--hard", reason ? base : "HEAD");
		else await git(wt, "checkout", "--detach", "--force", (await git(repo, "rev-parse", branch)).out.trim());
		await git(wt, "clean", "-fd");
	};
	await resetWorktree();

	// Rework: a failure that rewriting the item can fix gets a fresh read-only look at the code, which rewrites the item,
	// makes it wait for what it lacks, or gives up with the reason. Never the same item again unchanged.
	const count = () => { state.reworks = { ...(state.reworks ?? {}), [item.key]: reworks + 1 }; };
	const reworkItem = async (why) => {
		const all = ctx.currentItems?.() ?? [];
		const missing = await missingPaths(why);
		const waitOn = (ids, note) => {
			const waitFor = { ...(state.waitFor ?? {}), [item.key]: [...new Set([...(state.waitFor?.[item.key] ?? []), ...ids])] };
			if (!graphOk({ waitFor })) return undefined;
			state.waitFor = waitFor;
			count();
			return { note };
		};
		const related = all.filter((o) => o.key !== item.key && (areasOverlap(o.areas ?? [], item.areas ?? []) || `${why}\n${t.reply}`.includes(o.id)));
		const rest = all.filter((o) => o.key !== item.key && !related.includes(o) && isOpen(o));
		const status = (o) => state.done[o.key] ? "done" : state.failed[o.key] ? "failed" : "open";
		const others = [...related, ...rest].slice(0, 80).map((o) => `- ${o.id} · ${status(o)} · ${o.title.slice(0, 90)}${o.areas?.length ? ` · ${o.areas.join(", ")}` : ""}`).join("\n") || "(none)";
		setDoing("rework: finding out why it failed");
		save();
		const rref = { id: web ? undefined : randomUUID(), web };
		const rt = await turn(reworkPrompt(c, item, why, t.reply, missing, others), Math.min(30, Math.max(10, Math.round(c.itemMinutes / 2))), onActivity, "coding", rref, `rework ${item.id}: ${item.title}`.slice(0, 80));
		await resetWorktree(); // read-only: whatever it changed goes
		if (rref.id) state.sessions = { ...(state.sessions ?? {}), [rref.id]: { item: item.id, status: "rework", web: !!web } };
		if (rt.status !== "ok") return undefined; // could not look: the failure stays as it is
		appendFileSync(join(repo, DIR, "notes", `${item.id}.md`), `\n\n## Rework (fresh read-only session)\n\n${rt.reply}\n`);
		const first = (re) => rt.reply.match(re)?.[1]?.trim();
		const give = first(/^\s*GIVE UP:\s*(.+)$/im);
		const rewrite = first(/^\s*REWRITE:\s*(.+)$/im);
		const after = first(/^\s*AFTER:\s*(.+)$/im);
		const obsolete = first(/^\s*OBSOLETE:\s*(.+)$/im);
		if (rewrite || obsolete) {
			const KEEP = /\[(model|thinking|tier|big|check|readonly|files=|lines=|min=)[^\]]*\]/gi;
			const keep = (item.line.match(KEEP) ?? []).join(" ");
			let body = rewrite
				? rewrite.replace(/^-\s\[\s\]\s*/, "").replace(/^[A-Z]+\d+[A-Za-z0-9-]*\s*[—:-]\s*/, "").replace(KEEP, "").trim()
				// "already met": the item runs once more to show it (ALREADY DONE runs the checks), it is never just marked done
				: `${item.line.replace(KEEP, "").trim()} (A rework found it may already be met: ${obsolete.slice(0, 400)}. Verify every Done when condition; if all hold, change nothing and reply ALREADY DONE.)`;
			if (!/Done when:\s*\S/i.test(body)) { count(); return { giveUp: "the rework gave no usable Done when" }; }
			if (!/\[areas?:/i.test(body) && item.areas?.length) body += ` [areas: ${item.areas.join(", ")}]`;
			let line = `${item.id} — ${body}${keep ? ` ${keep}` : ""}`;
			let parsed;
			try { parsed = parseQueue(`- [ ] ${line}`)[0]; } catch { parsed = undefined; }
			if (!parsed) { count(); return { giveUp: "the rework's item line was malformed" }; }
			if (parsed.line.replace(/\s+/g, " ") === item.line.replace(/\s+/g, " ")) { count(); return { giveUp: "the rework could only repeat the item unchanged" }; }
			const outside = (parsed.areas ?? []).filter((a) => !pathAllowed(a, c.allowedPaths));
			if (outside.length) {
				if (!canWiden || outside.some((a) => !ordinaryScopeFile(wt, a)) || (state.scope?.[item.key]?.length ?? 0) + outside.length > (c.widenMax ?? 12)) { count(); return { giveUp: `the item needs ${outside.join(", ")}, outside the allowed paths` }; }
				widen(outside, `rework: the item also changes ${outside.join(", ")}`);
			}
			const known = new Set(all.map((o) => o.id));
			const unknown = (parsed.after ?? []).filter((d) => d !== "*" && !known.has(d) && !all.some((o) => o.id.startsWith(d)));
			if (unknown.length || !graphOk({ rewrites: { ...(state.rewrites ?? {}), [item.key]: line } })) line = line.replace(/\s*\[after:[^\]]*\]/i, ""); // drop prerequisites that do not exist or would close a cycle
			state.rewrites = { ...(state.rewrites ?? {}), [item.key]: line };
			count();
			try { appendFileSync(join(repo, DIR, "decisions.md"), `\n## ${item.id} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}\nReworked after: ${firstLine(why).slice(0, 300)}\nWas: ${item.line}\nNow: ${line}\n`); } catch {}
			return { note: rewrite ? `rewritten: ${parseQueue(`- [ ] ${line}`)[0].title.slice(0, 120)}` : "may already be met · runs once more to verify" };
		}
		if (after) {
			const ids = [...new Set(after.split("—")[0].match(/\b[A-Z]+\d+[A-Za-z0-9-]*\b/g) ?? [])].filter((id) => all.some((o) => (o.id === id || (o.child && o.id.startsWith(id))) && isOpen(o)));
			const r = ids.length && waitOn(ids, `waits for ${ids.join(", ")}: ${after.split("—").slice(1).join("—").trim().slice(0, 120)}`);
			if (r) return r;
			count();
			return { giveUp: `needs ${after.slice(0, 120)}, which is not an open item` };
		}
		count();
		return { giveUp: give ? give : `the rework gave no answer: ${firstLine(rt.reply).slice(0, 120)}` };
	};
	let reworkNote = "";
	const reworks = state.reworks?.[item.key] ?? 0;
	if (kind === "fail" && c.rework !== false && !item.check && reworkable(reason) && !ctx.stopRequested()) {
		if (reworks >= (c.maxReworks ?? 2)) reason = `needs you: reworked ${reworks}× and still failing · ${firstLine(reason)}`;
		else {
			const outcome = await reworkItem(reason);
			if (outcome?.giveUp) reason = `needs you: ${outcome.giveUp.slice(0, 200)} (rework) · ${firstLine(reason)}`;
			else if (outcome) { kind = "reworked"; reworkNote = outcome.note; }
		}
	}
	delete state.running[slot];

	if (!reason) {
		state.done[item.key] = sha;
		delete state.failed[item.key];
		log(sha === "checked" ? `PASS ${item.id} · checked, nothing to change · ${mins} min · w${slot}` : `PASS ${item.id} · ${sha} · ${m.files.length} files · net ${m.net} lines · ${mins} min · w${slot}`);
	} else if (kind === "gaps") {
		state.fixes = { ...(state.fixes ?? {}), [item.key]: [...(state.fixes?.[item.key] ?? []), ...fixLines] };
		const ids = fixLines.flatMap((l) => parseQueue(l).map((i) => i.id));
		state.waitFor = { ...(state.waitFor ?? {}), [item.key]: [...new Set([...(state.waitFor?.[item.key] ?? []), ...ids])] };
		delete state.failed[item.key];
		log(`GAPS ${item.id} · found ${ids.length} production gap(s) → queued ${ids.join(", ")} · ${item.id} checks again after them · ${mins} min`);
	} else if (kind === "waiting") {
		delete state.failed[item.key];
		log(`WAITING ${item.id} · needs ${state.waitFor[item.key].join(", ")} first · runs again after them · ${mins} min`);
	} else if (kind === "deferred") {
		state.deferred = { ...(state.deferred ?? {}), [item.key]: true };
		delete state.failed[item.key];
		log(`DEFERRED ${item.id} · ${firstLine(reason).slice(0, 140)} · will try again once the other pending items are done · ${mins} min`);
	} else if (kind === "split") {
		state.splits = { ...(state.splits ?? {}), [item.key]: splitLines };
		delete state.failed[item.key];
		log(`SPLIT ${item.id} · could not be done in one go (${firstLine(reason).slice(0, 80)}) · now ${splitLines.length} smaller items ${item.id}a…${item.id}${String.fromCharCode(96 + splitLines.length)}${kept}`);
	} else if (kind === "reworked") {
		delete state.failed[item.key];
		log(`REWORK ${item.id} · ${firstLine(reason).slice(0, 100)} → ${reworkNote}${kept} · ${mins} min`);
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
		state.sessions[ref.id].status = !reason ? "pass" : ["split", "gaps", "deferred", "waiting", "reworked"].includes(kind) ? kind : reason === "stopped by request" ? "stopped" : "fail";
		if (!reason && ctx.c.deleteSessions === "pass") await deleteSessions(ctx, [ref.id]);
	}
	save();
	release(); // recorded in state.splits / state.fixes by now, or not added at all
	notifyRunner(!reason ? "completion" : ["deferred", "conflict", "gaps", "split", "waiting", "reworked"].includes(kind) ? "deferred" : "failure", { id: item.id, kind, runId: state.runId });
	return { pass: !reason, kind, redone, stopped: reason === "stopped by request" };
}

// ---------- resources: stray processes, simulators, memory ----------

/** Processes whose working directory is inside `dir`: dev servers, emulators and watchers a worker left running. */
export async function straysIn(dir) {
	let root;
	try { root = realpathSync(dir); } catch { return []; }
	const inside = (p) => p === root || p.startsWith(`${root}/`);
	const mine = new Set([process.pid, process.ppid]);
	const pids = [];
	if (process.platform === "linux") {
		for (const p of readdirSync("/proc")) {
			if (!/^\d+$/.test(p) || mine.has(Number(p))) continue;
			try { if (inside(readlinkSync(`/proc/${p}/cwd`))) pids.push(Number(p)); } catch {}
		}
		return pids;
	}
	const r = await run(root, "lsof", ["-n", "-P", "-d", "cwd", "-Fpn"], { timeoutMs: 20_000 });
	let pid;
	for (const line of r.out.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid && !mine.has(pid) && inside(line.slice(1))) pids.push(pid);
	}
	return [...new Set(pids)];
}

export async function killStrays(dir, log, label = "", keep = new Set()) {
	const pids = (await straysIn(dir)).filter((p) => !keep.has(p));
	if (!pids.length) return 0;
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (let i = 0; i < 12 && pids.some(pidAlive); i++) await sleep(250);
	for (const pid of pids.filter(pidAlive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
	log?.(`CLEANUP ${label} · stopped ${pids.length} process(es) left running in its worktree`);
	return pids.length;
}

/** iOS simulators currently booted (macOS with Xcode only); undefined elsewhere. */
export function bootedSimulators() {
	if (process.platform !== "darwin") return undefined;
	const r = spawnSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8", timeout: 15_000 });
	if (r.status !== 0) return undefined;
	try { return new Set(Object.values(JSON.parse(r.stdout).devices ?? {}).flat().map((d) => d.udid)); } catch { return undefined; }
}

/** Memory a new item may still use, in GB (macOS counts inactive and purgeable pages as available). */
export function availableMemoryGB() {
	try {
		if (process.platform === "linux") {
			const kb = Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1]);
			if (kb) return kb / 1024 / 1024;
		}
		if (process.platform === "darwin") {
			const out = spawnSync("vm_stat", [], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
			const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 4096);
			const pages = (name) => Number(out.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1] ?? 0);
			const n = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
			if (n) return (n * page) / 1024 ** 3;
		}
	} catch {}
	return freemem() / 1024 ** 3;
}

export function memoryFloorGB(c) {
	return Number(c.minFreeMemoryGB) > 0 ? Number(c.minFreeMemoryGB) : Math.max(4, (totalmem() / 1024 ** 3) * 0.12);
}

// ---------- interrupted workers ----------

/** True only when nothing listens at the URL any more (the server process is gone), not on timeouts or HTTP errors. */
export async function connectionRefused(url) {
	try {
		await fetch(`${String(url).replace(/\/$/, "")}/api/agent/running`, { signal: AbortSignal.timeout(3000) });
		return false;
	} catch (e) {
		return /ECONNREFUSED/.test(`${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""} ${e?.code ?? ""}`);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Workers left in state.running by a crash, sleep or a Pi Web restart: stop them if they still run, keep whatever
 *  they changed on a queue-failed/<id>-interrupted-* branch, reset their worktree and queue the item again.
 *  Returns what could not be resolved safely (those slots are left untouched). */
/** Commit (or stash-snapshot) everything in a worktree onto a new branch, and check the branch really holds it. */
export async function preserveWork(repo, wt, name, message, dirty) {
	const step = async (label, r) => (r.code === 0 ? undefined : `${label}: ${firstLine(r.out) || `exit ${r.code}`}`);
	let sha;
	if (dirty) {
		const add = await git(wt, "add", "-A");
		let err = await step("git add", add);
		if (err) return { error: err };
		if (wt === repo) {
			const st = await git(wt, "stash", "create", message);
			if (st.code !== 0 || !st.out.trim()) return { error: `git stash create: ${firstLine(st.out) || "no snapshot made"}` };
			sha = st.out.trim();
		} else {
			err = await step("git commit", await git(wt, "commit", "--no-verify", "-m", message));
			if (err) return { error: err };
			sha = (await git(wt, "rev-parse", "HEAD")).out.trim();
			// the commit must hold the whole working tree, or the reset below would lose the rest
			if (!(await treeIsClean(wt))) return { error: "changes remained after the commit" };
		}
	} else sha = (await git(wt, "rev-parse", "HEAD")).out.trim();
	if (!/^[0-9a-f]{7,64}$/.test(sha ?? "")) return { error: "no commit to keep" };
	const err = await step("git branch", await git(repo, "branch", name, sha));
	if (err) return { error: err };
	if ((await git(repo, "rev-parse", `refs/heads/${name}`)).out.trim() !== sha) return { error: `branch ${name} does not point at the saved work` };
	return { name, sha };
}

export async function reconcileInterrupted({ repo, c, state, save, log, branch }) {
	const unresolved = [];
	let web, webKnown = false;
	const webClientFor = async () => {
		if (webKnown) return web;
		webKnown = true;
		const found = await findPiWeb(c);
		if (found.url) web = webClient({ ...c, piWebUrl: found.url });
		else if (/answered/.test(found.reason ?? "")) web = "unknown"; // reachable but refused: we cannot tell
		return web;
	};
	const tip = (await git(repo, "rev-parse", branch)).out.trim();
	for (const [slot, r] of Object.entries(state.running ?? {})) {
		const id = r?.id ?? `slot ${slot}`;
		let alive = false;
		if (Number.isInteger(r?.pid) && pidAlive(r.pid)) {
			for (const sig of ["SIGTERM", "SIGKILL"]) {
				try { process.kill(-r.pid, sig); } catch { try { process.kill(r.pid, sig); } catch {} }
				for (let i = 0; i < 20 && pidAlive(r.pid); i++) await sleep(250);
				if (!pidAlive(r.pid)) break;
			}
			alive = pidAlive(r.pid);
		}
		// the dead runner's shared background pi (its stdin closed, so it is normally gone already)
		if (Number.isInteger(r?.rpcPid) && pidAlive(r.rpcPid)) {
			for (const sig of ["SIGTERM", "SIGKILL"]) {
				try { process.kill(-r.rpcPid, sig); } catch { try { process.kill(r.rpcPid, sig); } catch {} }
				for (let i = 0; i < 20 && pidAlive(r.rpcPid); i++) await sleep(250);
				if (!pidAlive(r.rpcPid)) break;
			}
			if (pidAlive(r.rpcPid)) alive = true;
		}
		if (!alive && r?.web && r.sessionId) {
			const w = await webClientFor();
			if (w === "unknown") alive = true;
			// No Pi Web answers. Only a refused connection on the URL the worker ran on proves its server (and with it the
			// session) is gone; a timeout, a wrong port or no recorded URL proves nothing, so the slot stays reserved.
			else if (!w) alive = !(r.webUrl && (await connectionRefused(r.webUrl)));
			else if (w) {
				const active = async () => {
					const snap = await w.running(r.sessionId);
					return [...(snap.runningSessionIds ?? []), ...(snap.subagentsActiveSessionIds ?? [])].includes(r.sessionId);
				};
				try {
					if (await active()) {
						await w.send(r.sessionId, { type: "abort" }).catch(() => {});
						alive = true;
						for (let i = 0; i < 20 && alive; i++) {
							await sleep(3000);
							alive = await active().catch(() => true);
						}
					}
				} catch { alive = true; }
			}
		}
		if (alive) { unresolved.push(`${id}: its worker is still running`); continue; }
		const wt = r?.worktree ?? (c.worktrees === false ? repo : join(worktreeRoot(repo), `w${slot}`));
		if (c.killStrays !== false && wt !== repo) await killStrays(wt, log, id);
		let kept = "";
		if (existsSync(join(wt, ".git"))) {
			await git(wt, "rebase", "--abort");
			await git(wt, "merge", "--abort");
			const dirty = !(await treeIsClean(wt));
			const head = (await git(wt, "rev-parse", "HEAD")).out.trim();
			const ahead = wt !== repo && head && head !== tip && (await git(wt, "merge-base", "--is-ancestor", head, tip)).code !== 0;
			if (dirty || ahead) {
				// Preserve first, verify, and only then reset. Any failed step leaves the worktree untouched.
				const kept0 = await preserveWork(repo, wt, `queue-failed/${String(id).replace(/[^A-Za-z0-9._-]/g, "-")}-interrupted-${Date.now()}`, `queue INTERRUPTED ${id}`, dirty);
				if (kept0.error) { unresolved.push(`${id}: could not keep its work (${kept0.error}); worktree left untouched`); continue; }
				kept = ` · work kept on ${kept0.name}`;
			}
			if (wt === repo) await git(wt, "reset", "--hard", "HEAD");
			else await git(wt, "checkout", "--detach", "--force", tip);
			await git(wt, "clean", "-fd");
		}
		delete state.running[slot];
		if (r?.key && /^(runner error|stopped by request)/.test(state.failed?.[r.key] ?? "")) delete state.failed[r.key];
		log(`RECONCILED ${id} · interrupted worker is gone${kept} · ${r?.key ? "item queued again" : "slot freed"}`);
	}
	save();
	return unresolved;
}

// ---------- the scheduler ----------

export async function main(repo) {
	await ensureDir(repo);
	const log = makeLog(repo);
	const pidFile = join(repo, DIR, "runner.pid");
	const release = acquireProcessLock(pidFile);
	const onSignal = () => writeFileSync(join(repo, DIR, "STOP"), "signal");
	const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
	process.on("exit", release);
	for (const sig of signals) process.on(sig, onSignal);
	let heartbeat;
	try {
	const c = readConfig(repo);
	const statePath = join(repo, DIR, "state.json");
	const state = { done: {}, failed: {}, retried: {}, running: {}, ...loadJson(statePath, {}) };
	const stopRequested = () => existsSync(join(repo, DIR, "STOP"));
	const pauseRequested = () => existsSync(join(repo, DIR, "PAUSE"));
	if (stopRequested() || pauseRequested()) return log("NOT STARTED: manually stopped/paused; explicit /queue start is required");
	if (Object.keys(state.running).length && c.autoReconcile === false) {
		problem(repo, "Interrupted workers/worktrees require reconciliation; refusing to reset or reuse them (autoReconcile is off).");
		return log("NOT STARTED: interrupted workers remain; worktrees preserved");
	}
	state.phase = "starting";
	delete state.startedAt;
	state.task = c.task;
	state.runId = randomUUID();
	const save = () => { state.heartbeat = Date.now(); saveJson(statePath, state); };
	save();
	heartbeat = setInterval(save, 60000);
	rmSync(join(repo, DIR, "problem.txt"), { force: true });

	const branch = (await git(repo, "branch", "--show-current")).out.trim();
	if (!branch) return log("NOT STARTED: the repo is on a detached HEAD; check out a branch first");
	if (Object.keys(state.running).length) {
		// a crash, sleep or Pi Web restart left workers behind: stop them, keep their work, queue the items again
		state.phase = "reconciling interrupted workers";
		save();
		const left = await reconcileInterrupted({ repo, c, state, save, log, branch });
		if (left.length) {
			problem(repo, `Interrupted workers could not be reconciled automatically:\n- ${left.join("\n- ")}\n\nTheir worktrees are untouched. Stop those sessions, then /queue start again.`);
			return log(`NOT STARTED: interrupted workers remain (${left.join("; ")}); worktrees preserved`);
		}
	}
	if (!(await treeIsClean(repo))) return log("NOT STARTED: working tree is not clean (commit or stash first)");
	const queuePath = join(repo, c.queue);
	if (!c.queue) return log("NOT STARTED: no work list set (run /task to plan one, or set \"queue\" in .pi-queue/config.json)");
	if (!existsSync(queuePath)) return log(`NOT STARTED: queue file ${c.queue} not found`);
	try { dependencyGraph(allItems(readFileSync(queuePath, "utf8"), state)); }
	catch (e) { return log(`NOT STARTED: ${e.message}`); }

	// rpcPool is shared by reference: turns run on copies of ctx, and each copy must find the same slot processes
	const ctx = { repo, c, state, save, log, lock: mutex(), branch, stopRequested, pi: await resolvePi(c), env: await loginEnv(), web: null, rpcPool: { max: 1, workers: [] } };
	ctx.queueText = () => { try { return readFileSync(queuePath, "utf8"); } catch { return ""; } };
	ctx.currentItems = () => allItems(ctx.queueText(), state);
	ctx.plannedCount = () => parseQueue(ctx.queueText()).length;
	if (c.runIn !== "cli") {
		const found = await findPiWeb(c);
		if (found.url) {
			c.piWebUrl = found.url;
			ctx.web = webClient(c);
		} else if (c.runIn === "web") return log(`NOT STARTED: Pi Web not usable: ${found.reason}`);
		else log(`Pi Web not usable (${found.reason}); items run as background pi instead`);
	}
	const parallel = c.worktrees ? Math.max(1, Math.floor(c.parallel) || 1) : 1;
	const startTip = (await git(repo, "rev-parse", branch)).out.trim();
	log(`START · branch ${branch} · ${c.worktrees ? `up to ${parallel} coding + ${parallel} verification (worktrees)` : "one at a time in your repo folder"} · ${c.model || "default model"} @ ${c.thinking || "default"} · ${ctx.web ? `items run as Pi Web sessions (${c.piWebUrl})` : `items run as background pi (${ctx.pi})`}`);

	// worktrees are made when a slot is first used; w0 now, for the baseline check
	let maxW = c.worktrees ? Math.max(1, Math.floor(c.parallel) || 1) : 1;
	ctx.rpcPool.max = maxW;
	const minW = Math.min(maxW, Math.max(1, Math.floor(c.parallelMin) || 1));
	let width = Math.min(maxW, Math.max(minW, Math.floor(c.parallelStart) || maxW));
	const wts = [];
	const prepLock = mutex();
	let memCheck = { at: 0, gb: Infinity, logged: 0 };
	const simsAtStart = c.killStrays !== false ? bootedSimulators() : undefined;
	try {
		wts[0] = c.worktrees ? await prepareWorktree(ctx, 0) : repo;
	} catch (e) {
		return log(`NOT STARTED: ${e.message}`);
	}
	if (checkBroker(c)) log("CHECKS via pi-check · shared across worktrees, cached by file content, pre-existing Go failures do not block");
	state.phase = "checking the unchanged code (baseline)";
	save();
	let baseline = await runChecks(c, wts[0]);
	if (baseline) {
		// a flaky test should not cost a whole night: one more try before giving up
		log(`BASELINE failed once (${firstLine(baseline).slice(0, 120)}) · trying again`);
		baseline = await runChecks(c, wts[0]);
		if (!baseline) log("BASELINE passed on the second try · a check is flaky");
	}
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

	state.startedAt = Date.now();
	save();
	notifyRunner("ready", { runId: state.runId });
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
			if (i) return state.done[i.key] || state.released?.[i.key] ? "done" : state.failed[i.key] ? "failed" : "open";
			const kids = items.filter((k) => k.child && k.id.startsWith(id) && /^[a-z]$/.test(k.id.slice(id.length)));
			if (kids.length) return kids.every((k) => state.done[k.key] || state.released?.[k.key]) ? "done" : kids.some((k) => state.failed[k.key] && !state.released?.[k.key]) ? "failed" : "open";
			return "unknown"; // a typo or an id from elsewhere: ignored
		};
		const open = items.filter((i) => !finished(i) && !inFlight.has(i.key));
		const eligible = new Set(open.map((i) => i.key));
		const ordered = orderQueue(items, state).filter((i) => eligible.has(i.key));
		const parked = (i) => state.retried[i.key] || state.deferred?.[i.key];
		let firstPassPending = [...inFlight.values()].some((i) => !i.quarantined && !parked(i));
		for (const i of ordered) {
			let wait = false;
			for (const d of i.after ?? []) {
				const st = depState(d);
				// a [check] still runs when an item it covers failed: it reports what is missing instead of silently never running
				if (st === "failed" && i.check) continue;
				if (st === "failed" || st === "unknown") {
					state.failed[i.key] = `depends on ${d}, which ${st === "unknown" ? "is unknown" : "failed"}`;
					log(`FAIL ${i.id} · depends on ${d}, which failed · not started`);
					save();
					notifyRunner("failure", { id: i.id, runId: state.runId });
					wait = true;
					break;
				}
				if (st === "open") wait = true;
				if (st === "wildcard" && (items.some((o) => o !== i && !finished(o) && !(o.after ?? []).includes("*")) || inFlight.size)) wait = true;
			}
			if (wait) continue;
			// read-only items lock nothing: they read their own worktree snapshot and never merge
			if (!i.readonly && [...inFlight.values()].some((r) => (r.quarantined && (!r.areas?.length || !i.areas?.length)) || (!r.readonly && i.areas?.length && r.areas?.length && areasOverlap(i.areas, r.areas)))) continue;
			if (!parked(i)) firstPassPending = true;
			if (state.deferred?.[i.key] && firstPassPending) continue;
			if (!hasCapacity(i.check ? "verification" : "coding")) continue;
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
	const controlDir = join(repo, DIR, "control");
	const readControl = () => {
		if (!existsSync(controlDir)) return;
		const files = readdirSync(controlDir).filter((f) => f.endsWith(".json")).sort();
		if (!files.length) return;
		const list = files.filter((f) => !(state.controlReceipts ?? []).includes(f)).map((f) => loadJson(join(controlDir, f), {}));
		const items = (() => {
			try {
				return allItems(readFileSync(queuePath, "utf8"), state);
			} catch {
				return [];
			}
		})();
		for (const ctl of list) {
			if (ctl.task !== c.task) { log("CONTROL ignored: stale task"); continue; }
			if (ctl.by === "auto") {
				if (stopRequested() || pauseRequested() || readConfig(repo).manager === false || !ctl.approval || ctl.approval !== approvedTask(repo, readConfig(repo)) || !ctl.ids?.length || !ctl.ids.every((id) => items.some((i) => i.id === id && state.failed[i.key] === ctl.failures?.[id]))) continue;
				// release only lets dependents run; it changes nothing about the failed item itself
				if (ctl.action !== "release") try {
					// Budgets were reserved by the supervisor; repeat scope/ownership validation on live state.
					Object.assign(ctl, validateRecovery(ctl, state, allItems(readFileSync(queuePath, "utf8"), state), {}, c));
				} catch (e) { log(`CONTROL rejected: ${e.message}`); continue; }
			}
			if (ctl?.action === "parallel") {
				const n = Math.max(1, Math.floor(Number(ctl.value)) || 1);
				if (!c.worktrees) {
					log("CONTROL parallel ignored: this run works in the repo folder (worktrees: false)");
					continue;
				}
				while (slots < 2 * n) free.push(slots++);
				maxW = n; // both phase ceilings follow the configured parallelism
				ctx.rpcPool.max = n; // and the background pi processes (extra idle ones close as they are replaced)
				setWidth(n, "asked by you");
				try {
					const cf = join(repo, DIR, "config.json");
					writeFileSync(cf, `${JSON.stringify({ ...loadJson(cf, {}), parallel: n }, null, 2)}\n`);
				} catch {}
				continue;
			}
			const changed = applyControl(state, items, ctl ?? {});
			if (changed.length && ["retry", "repair", "amend", "limits", "rerun", "recheck", "next"].includes(ctl.action)) { failsInARow = 0; state.failureStreak = 0; halted = ""; }
			log(`CONTROL ${ctl?.action} ${(ctl?.ids ?? []).join(",") || (ctl?.action === "add" ? "" : "all")} · ${changed.length ? changed.join(", ") : "nothing matched"}${ctl?.by ? ` · by ${ctl.by}` : ""}`);
		}
		state.controlReceipts = [...(state.controlReceipts ?? []), ...files].slice(-1000);
		save();
		for (const file of files) rmSync(join(controlDir, file), { force: true });
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

	let failsInARow = state.failureStreak ?? 0;
	let cleanStreak = 0;
	const failureLimit = Number(c.stopAfterFailuresInARow);
	const safetyHalt = () => Number.isFinite(failureLimit) && failureLimit > 0 && failsInARow >= failureLimit;
	let halted = safetyHalt() ? `${failsInARow} failures in a row` : "";
	const slotLimit = () => c.worktrees ? 2 * maxW : 1;
	const free = Array.from({ length: slotLimit() }, (_, i) => i);
	let slots = free.length;
	const running = new Map();
	const phases = new Map(), waiters = [];
	let wakeScheduler;
	const phaseLimit = (phase) => phase === "coding" ? width : maxW;
	const hasCapacity = (phase) => [...phases.values()].filter((p) => p === phase).length < phaseLimit(phase);
	const pumpPhases = () => {
		for (let i = 0; i < waiters.length;) {
			const { slot, phase, resolve, reject } = waiters[i];
			if (stopRequested()) { waiters.splice(i, 1); resolve(false); continue; }
			// An uncertain worker cannot release its permit. Preserve waiting work instead
			// of hanging forever when that phase's entire capacity is quarantined.
			if ([...phases].filter(([s, p]) => p === phase && state.running[s]?.quarantined).length >= phaseLimit(phase)) {
				waiters.splice(i, 1);
				reject(new Error(`${phase} capacity quarantined; waiting work preserved`));
				continue;
			}
			if (!hasCapacity(phase)) { i++; continue; }
			waiters.splice(i, 1);
			phases.set(slot, phase);
			state.running[slot].phase = phase;
			save();
			resolve(true);
		}
	};
	// one agent session per `parallel`: coding turns and [check] sessions share it (checks without a session do not)
	let sessionsOpen = 0;
	const sessionWaiters = [];
	ctx.sessionGate = () => new Promise((resolve) => {
		const grant = () => { sessionsOpen++; let once = false; resolve(() => { if (once) return; once = true; sessionsOpen--; sessionWaiters.shift()?.(); }); };
		if (sessionsOpen < maxW) grant(); else sessionWaiters.push(grant);
	});
	ctx.acquirePhase = async (slot, phase) => {
		if (stopRequested()) return false;
		if (phases.get(slot) === phase) return true;
		// Never wait while holding the other resource: fixes/redos cannot deadlock checks.
		phases.delete(slot);
		state.running[slot].phase = `waiting-${phase}`;
		save();
		const acquired = new Promise((resolve, reject) => waiters.push({ slot, phase, resolve, reject }));
		pumpPhases();
		wakeScheduler?.(null);
		return acquired;
	};
	const setWidth = (w, why) => {
		if (w === width) return;
		log(`WIDTH ${width} → ${w} · ${why}`);
		width = w;
		state.width = w;
		save();
	};
	try {
	while (true) {
		readControl();
		pumpPhases();
		while (!halted && free.length && !stopRequested() && !pauseRequested()) {
			free.sort((a, b) => a - b);
			if (free[0] >= slotLimit()) break; // slots above a lowered ceiling stay idle
			// never start more work than the machine has memory for (servers, emulators, test runners add up fast)
			if (running.size > 0 && (memCheck.at === 0 || Date.now() - memCheck.at > 15_000)) memCheck = { ...memCheck, at: Date.now(), gb: availableMemoryGB() };
			if (running.size > 0 && memCheck.gb < memoryFloorGB(c)) {
				if (Date.now() - memCheck.logged > 10 * 60_000) { memCheck.logged = Date.now(); log(`MEMORY ${memCheck.gb.toFixed(1)} GB available (< ${memoryFloorGB(c).toFixed(0)} GB) · not starting more items until some finish`); }
				break;
			}
			const item = nextItem();
			if (!item) break;
			free.sort((a, b) => a - b);
			const slot = free.shift();
			inFlight.set(item.key, item);
			const phase = item.check ? "verification" : "coding";
			phases.set(slot, phase); // reserve capacity before asynchronous worktree preparation
			state.running[slot] = { id: item.id, key: item.key, phase, doing: "preparing worktree", startedAt: new Date().toISOString() };
			save();
			const p = (async () => {
				if (!wts[slot]) {
					wts[slot] = await prepLock(() => prepareWorktree(ctx, slot));
				}
				return workItem(ctx, slot, wts[slot], item);
			})()
				.catch(async (e) => {
					ctx.growthReserved?.delete(item.key);
					state.failed[item.key] = `runner error: ${e?.message ?? e}`;
					state.running[slot] = { ...(state.running[slot] ?? {}), id: item.id, key: item.key, worktree: wts[slot], quarantined: true };
					save();
					log(`ERROR ${item.id} · ${e?.message ?? e}`);
					// Free the slot right away when the worker is provably gone: stop it, keep its work on a branch, reset the worktree.
					// The item itself runs again at most twice this way; after that it stays failed for the supervisor.
					if (c.autoReconcile !== false && !stopRequested()) {
						const errors = (state.runnerErrors?.[item.key] ?? 0) + 1;
						state.runnerErrors = { ...(state.runnerErrors ?? {}), [item.key]: errors };
						// the item's turn is over: the pi process it used is shared with other items and stays
						const only = { ...state, running: { [slot]: { ...state.running[slot], rpcPid: undefined } }, failed: errors <= 2 ? state.failed : {} };
						const left = await reconcileInterrupted({ repo, c, state: only, save: () => {}, log, branch }).catch((err) => [String(err?.message ?? err)]);
						if (!left.length) {
							delete state.running[slot];
							save();
							return { pass: false, kind: errors <= 2 ? "requeued" : "fail" };
						}
					}
					item.quarantined = true;
					save();
					notifyRunner("quarantine", { id: item.id, runId: state.runId });
					log(`QUARANTINED ${item.id} · its worker could not be confirmed gone; slot w${slot} stays reserved, work preserved`);
					return { pass: false, kind: "fail" };
				})
				.then((r) => ({ r, slot, item }));
			running.set(slot, p);
		}
		if (running.size === 0) {
			readControl();
			if (!halted && !stopRequested() && !pauseRequested() && free.some((slot) => slot < slotLimit()) && nextItem()) continue; // the manager queued more work
			break;
		}
		// wake every few seconds to apply control requests while items run
		let wake;
		const done = await Promise.race([...running.values(), new Promise((res) => { wakeScheduler = res; wake = setTimeout(() => res(null), 5000); })]);
		wakeScheduler = undefined;
		clearTimeout(wake);
		if (!done) continue;
		const { r, slot, item } = done;
		running.delete(slot);
		if (c.killStrays !== false && wts[slot]) {
			// what the item started (servers, emulators, watchers) goes; the pool's pi processes run from the repo and stay
			if (wts[slot] !== repo) await killStrays(wts[slot], log, item.id, new Set(ctx.rpcPool.workers.map((w) => w.pid))).catch(() => {});
		}
		// simulators booted during the run are shut down once no other item could still be using them
		if (c.killStrays !== false && simsAtStart && running.size === 0) {
			const now = bootedSimulators();
			const extra = [...(now ?? [])].filter((u) => !simsAtStart.has(u));
			for (const u of extra) spawnSync("xcrun", ["simctl", "shutdown", u], { timeout: 60_000 });
			if (extra.length) log(`CLEANUP · shut down ${extra.length} simulator(s) booted by items`);
		}
		memCheck.at = 0;
		if (!state.running[slot]?.quarantined) {
			free.push(slot);
			phases.delete(slot);
			inFlight.delete(item.key);
		}
		pumpPhases();
		if (r.pass) {
			failsInARow = 0;
			recheckAfter(item);
		} else if (r.kind === "fail" && !r.stopped) failsInARow++;
		// a prerequisite that passes now (after a rework or a retry) lets the items that never started run
		try {
			const back = reopenDependents(state, allItems(readFileSync(queuePath, "utf8"), state));
			if (back.length) log(`REOPENED ${back.slice(0, 12).join(", ")}${back.length > 12 ? ` and ${back.length - 12} more` : ""} · their prerequisite no longer fails`);
		} catch {}
		state.failureStreak = failsInARow;
		save();
		if (c.adaptive !== false && c.worktrees) {
			if (r.pass && ++cleanStreak >= 3) {
				cleanStreak = 0;
				setWidth(Math.min(maxW, width + 1), "3 clean passes in a row");
			}
		}
		if (!halted && safetyHalt()) {
			halted = `${failsInARow} failures in a row`;
			log(`STOPPING: ${halted} (running items finish first)`);
		}
		if (stopRequested() && !halted) halted = "stop requested";
		if (pauseRequested() && !halted) halted = "paused after running items finished";
	}
	} catch (e) {
		onSignal();
		pumpPhases();
		await Promise.all(running.values());
		await closeRpcPool(ctx);
		throw e;
	}
	await closeRpcPool(ctx);
	if (pauseRequested() && !halted) halted = "paused after running items finished";
	state.phase = halted || (Object.keys(state.running).length ? "blocked: quarantined workers" : "finished");
	save();
	notifyRunner("completion", { runId: state.runId, phase: state.phase });
	const left = allItems(readFileSync(queuePath, "utf8"), state).filter((i) => !state.done[i.key] && !state.failed[i.key]).length;
	log(`END · passed ${Object.keys(state.done).length} · failed ${Object.keys(state.failed).length} · still open ${left}${halted ? ` · ${halted}` : ""}`);
	// merged items changed dependencies: bring the main checkout's install up to date so its own checks run
	if (c.setup && startTip) {
		const changed = (await git(repo, "diff", "--name-only", startTip, branch)).out.split("\n").filter((f) => GENERATED.test(f) || /(^|\/)(package\.json|go\.mod|pyproject\.toml|requirements[^/]*\.txt)$/.test(f));
		if (changed.length && (await treeIsClean(repo))) {
			const r = await run(repo, LOGIN_SHELL, ["-lc", c.setup], { timeoutMs: 20 * 60_000, env: cleanEnv() });
			log(r.code === 0 ? `SETUP main checkout · dependencies changed (${changed.slice(0, 3).join(", ")}) · installed` : `SETUP main checkout failed (exit ${r.code}) · run it yourself: ${c.setup}`);
		}
	}
	try {
		const decisions = existsSync(join(repo, DIR, "decisions.md")) ? `\n\n# Decisions the automatic manager made (review these)\n${readFileSync(join(repo, DIR, "decisions.md"), "utf8")}` : "";
		writeFileSync(join(repo, DIR, "report.md"), `${runReport(allItems(readFileSync(queuePath, "utf8"), state), state)}${decisions}\n`);
	} catch {}
	if (c.deleteSessions && c.deleteSessions !== "pass" && !halted) {
		const ids = Object.entries(state.sessions ?? {})
			.filter(([, x]) => !x.deleted && !x.archived && (x.status === "pass" || x.status === "split"))
			.map(([id]) => id);
		const mode = c.deleteSessions === "archive" ? "archive" : "delete";
		const n = await deleteSessions(ctx, ids, mode);
		if (n) log(`CLEANUP · ${mode === "archive" ? "archived" : "removed"} ${n} finished item sessions (sessions of failed items are kept; /task cleanup removes the rest)`);
	}
	} finally {
		clearInterval(heartbeat);
		for (const sig of signals) process.off(sig, onSignal);
		process.off("exit", release);
		release();
	}
}

export { piTurn, webTurn, checksText, prepareWorktree };

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
