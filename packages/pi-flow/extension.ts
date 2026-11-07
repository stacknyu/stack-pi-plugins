/**
 * pi-flow — plan a large task, answer its questions, and let a queue of fresh sessions build it.
 *
 *   /task setup              once per repo: plugins from your profile, verified checks, AGENTS.md block
 *   /task <request>          plan a task in this session; it asks its questions, then starts the queue itself
 *   /task status | list     where things stand
 *   /task resume <slug>      continue planning a task in this session
 *   /task cleanup [--all]    delete the task's finished Pi sessions (--all: also worktrees, failed branches)
 *   /task save-profile       remember this repo's project plugins for /task setup in other repos
 *   /queue start|stop|status|watch|retry|problem   control the queue directly
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULTS,
	DIR,
	LOGIN_SHELL,
	allItems,
	acquireProcessLock,
	enqueueControl,
	pidAlive,
	areasOverlap,
	dependencyGraph,
	checkBroker,
	checkLine,
	cleanEnv,
	deleteSessions,
	sessionFiles,
	ensureDir,
	findPiWeb,
	git,
	loadJson,
	itemConfig,
	parseQueue,
	readConfig,
	run,
	tail,
	webClient,
} from "./runner.mjs";
import { FLOW_DIR, TASKS_DIR, exclude, saveProfile, setupRepo } from "./setup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "supervisor.mjs");

// ---------- small helpers ----------

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function runnerPid(cwd: string, owner = "runner"): number | undefined {
	try {
		const pid = Number(readText(join(cwd, DIR, `${owner}.pid`)).trim());
		if (!pid) return undefined;
		return pidAlive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function readState(cwd: string): any {
	try {
		return JSON.parse(readText(join(cwd, DIR, "state.json")) || "{}");
	} catch {
		return {};
	}
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function problemText(cwd: string, lines = 40): string {
	const t = readText(join(cwd, DIR, "problem.txt")).trim();
	if (!t) return "";
	const all = t.split("\n");
	return all.length <= lines ? t : `${all.slice(0, lines - 14).join("\n")}\n…\n${all.slice(-12).join("\n")}`;
}

function taskFile(cwd: string, slug: string) {
	return join(cwd, TASKS_DIR, slug, "task.json");
}

function listTasks(cwd: string): any[] {
	try {
		return readdirSync(join(cwd, TASKS_DIR))
			.map((slug) => loadJson(taskFile(cwd, slug), null))
			.filter(Boolean)
			.sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
	} catch {
		return [];
	}
}

/** Runtime status per task lives in the ignored .pi-flow/status.json, so committed plan files never change after handoff. */
function flowStatus(cwd: string): Record<string, any> {
	return loadJson(join(cwd, FLOW_DIR, "status.json"), {});
}
function setFlowStatus(cwd: string, slug: string, patch: any) {
	const all = flowStatus(cwd);
	all[slug] = { ...(all[slug] ?? {}), ...patch };
	mkdirSync(join(cwd, FLOW_DIR), { recursive: true });
	writeFileSync(join(cwd, FLOW_DIR, "status.json"), `${JSON.stringify(all, null, 2)}\n`);
}
/** planning · queued · running · done (all items passed) · finished (some failed) · cleaned */
function taskStatus(cwd: string, t: any): string {
	const fs = flowStatus(cwd)[t.slug] ?? {};
	if (fs.cleanedAt) return "cleaned";
	if (t.status === "planning") return "planning";
	let cfg: any = {};
	try {
		cfg = readConfig(cwd);
	} catch {}
	if (cfg.task !== t.slug) return fs.status ?? t.status;
	if (runnerPid(cwd) || runnerPid(cwd, "supervisor")) return "running";
	const state = readState(cwd);
	const open = allItems(readText(join(cwd, cfg.queue)), state).filter((i: any) => !state.done?.[i.key] && !state.failed?.[i.key]).length;
	if (open > 0) return "queued (stopped)";
	return Object.keys(state.failed ?? {}).length ? "finished with failures" : "done";
}

function makeSlug(cwd: string, request: string): string {
	const base =
		request
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w && !["the", "a", "an", "and", "to", "of", "for", "in", "on", "with", "please", "i", "we", "want"].includes(w))
			.slice(0, 5)
			.join("-")
			.slice(0, 40)
			.replace(/-+$/, "") || "task";
	let slug = base;
	for (let n = 2; existsSync(join(cwd, TASKS_DIR, slug)); n++) slug = `${base}-${n}`;
	return slug;
}

/** A Pi Web client when Pi Web is running, else null. Pi Web is optional everywhere in pi-flow. */
async function piWeb(cwd: string): Promise<any> {
	try {
		const cfg: any = readConfig(cwd);
		const found: any = await findPiWeb(cfg);
		return found.url ? webClient({ ...cfg, piWebUrl: found.url }) : null;
	} catch {
		return null;
	}
}

// ---------- live panel ----------

function liveLines(cwd: string): string[] {
	const pid = runnerPid(cwd);
	const state = readState(cwd);
	const done = state.done ?? {};
	const failed = state.failed ?? {};
	let open = 0;
	let cfg: any = {};
	try {
		cfg = readConfig(cwd);
		open = allItems(readText(join(cwd, cfg.queue)), state).filter((i: any) => !done[i.key] && !failed[i.key]).length;
	} catch {}
	const now = Date.now();
	const width = pid && state.width ? ` · width ${state.width}/${cfg.parallel ?? "?"}` : "";
	const phase = pid && state.phase && state.phase !== "running items" ? ` · ${state.phase}` : "";
	const lines = [
		`${pid ? "● queue RUNNING" : "○ queue not running"}${cfg.task ? ` · task ${cfg.task}` : ""} · passed ${Object.keys(done).length} · failed ${Object.keys(failed).length} · open ${open}${width}${phase}`,
	];
	if (pid) {
		for (const r of Object.values(state.running ?? {}) as any[]) {
			lines.push(`  ${r.id} · ${ago(now - Date.parse(r.startedAt))} · ${r.doing ?? "starting"} (${ago(now - (r.since ?? now))} ago) · ${r.tools ?? 0} tool calls`);
		}
	}
	const log = readText(join(cwd, DIR, "log.md"))
		.trim()
		.split("\n")
		.filter((l) => /\b(PASS|FAIL|CONFLICT|REDO|SPLIT|WIDTH|LIMITS RAISED|STOPP|END|NOT STARTED|ERROR|CRASH|CLEANUP)\b/.test(l))
		.slice(-5)
		.map((l) => `  ${l.replace(/^- \d{4}-\d\d-\d\d /, "")}`);
	const manager = loadJson(join(cwd, DIR, "manager.json"), {});
	if (manager.id) lines.push(`  automatic manager ${runnerPid(cwd, "supervisor") ? "watching" : "idle"} · ${manager.id}`);
	return [...lines, ...log];
}

/** Start the background runner. Returns an error text, or "" when it started (or already ran to the end). */
async function startRunner(cwd: string, resume = false): Promise<string> {
	await ensureDir(cwd);
	if (runnerPid(cwd) || runnerPid(cwd, "supervisor")) return "Queue or supervisor is still active; wait for it to finish before starting again.";
	const release = acquireProcessLock(join(cwd, DIR, "start.pid"));
	try {
	if (resume) for (const marker of ["STOP", "PAUSE"]) rmSync(join(cwd, DIR, marker), { force: true });
	const logFile = join(cwd, DIR, "log.md");
	const before = readText(logFile).length;
	const out = openSync(join(cwd, DIR, "runner.out"), "a");
	const child = spawn(LOGIN_SHELL, ["-lc", 'exec node "$0" "$1"', RUNNER, cwd], { cwd, detached: true, stdio: ["ignore", out, out] });
	child.on("error", () => {});
	child.unref();
	closeSync(out);
	await new Promise((r) => setTimeout(r, 1500));
	if (runnerPid(cwd)) return "";
	const fresh = readText(logFile).slice(before);
	if (/\bSTART\b/.test(fresh) && !/NOT STARTED|CRASH/.test(fresh)) return "";
	const last = fresh.trim().split("\n").slice(-1).join("\n");
	return `${last || "(no log line)"}\n\n${problemText(cwd) || "(see .pi-queue/runner.out)"}`;
	} finally { release(); }
}

// ---------- planning ----------

function planPrompt(cwd: string, slug: string, request: string, models: any[] = []): string {
	const info: any = loadJson(join(cwd, FLOW_DIR, "repo.json"), null);
	const ok = (info?.checks ?? []).filter((c: any) => c.ok === true).map((c: any) => `  - ${c.cmd}`);
	const bad = (info?.checks ?? []).filter((c: any) => c.ok === false).map((c: any) => `  - ${c.cmd} (FAILS today)`);
	const tests = (info?.checks ?? []).filter((c: any) => c.ok === null).map((c: any) => `  - ${c.cmd} (not run by setup)`);
	const facts = info
		? `Repo facts (from /task setup, ${info.updatedAt}):
- package manager: ${info.pm || "none"}; packages: ${(info.packages ?? []).map((p: any) => p.dir).join(", ") || "none"}${info.go?.length ? `; Go: ${info.go.join(", ")}` : ""}
- check commands that pass on the current code:
${ok.join("\n") || "  (none)"}
${bad.length ? `- check commands that fail today (do not use unless the task fixes them first):\n${bad.join("\n")}\n` : ""}${tests.length ? `- tests available:\n${tests.join("\n")}\n` : ""}`
		: "Repo facts: /task setup has not run here, so no check commands are verified yet. Find the right typecheck/lint/build commands yourself and make sure they pass on the current code.";
	const W = `${TASKS_DIR}/${slug}`;
	return `You are PLANNING a large task so that a queue of fresh, unattended agents can implement it item by item. In this phase do not change any code or config; write only the planning files.

TASK: ${request}

Workspace: ${W}/ (task.json already exists there)
${facts}

Available authenticated models (exact provider/id, supported thinking levels, advertised USD per million tokens; prices are not speed benchmarks):
${models.map((m) => `- ${m.provider}/${m.id}: thinking=${getSupportedThinkingLevels(m).join(",")}; input=${m.cost?.input ?? "unknown"}, output=${m.cost?.output ?? "unknown"}`).join("\n") || "No catalog supplied: retain configured defaults; do not invent a model id."}
Queue defaults: model=${readConfig(cwd).model || "Pi default"}, thinking=${readConfig(cwd).thinking || "Pi default"}.

The pi-flow skill's references/items.md explains the item format, tags and how the queue treats them; read it before writing items.md.

## 1. Research
- Read AGENTS.md and the AGENTS.md of every app or folder the task touches.
- Find every place the task touches: files, functions, endpoints, types, tests, docs. Check what the code does now; do not trust old docs or memory.
- Use subagents for parallel read-only searches when that is faster. Only you write the planning files.

## 2. Write the plan
- ${W}/brief.md — the goal in a few lines; what "done" means for the whole task; what is out of scope; main risks.
- ${W}/inventory.md — the facts you found, with paths: what exists, how it behaves now, what each part of the task touches. This is the evidence the items rely on.
- ${W}/map/<area>.md — one per area when the task spans several: exactly what changes there and why, and what must stay unchanged.
- ${W}/rules.md — short, task-specific rules every item must follow (contracts that must not change, patterns to reuse, things not to do).
- ${W}/questions.md — decisions only the user can make, one per line: "- [ ] Q1: <question> — Options: <a> / <b> — Recommended: <a>, because <reason>". Leave it empty if there are none.
- ${W}/items.md — the work list, format below.
- ${W}/task.json — keep the existing fields and add:
  "allowedPaths": [the folders/files items may change, as narrow as the task allows; include docs folders if AGENTS.md requires doc updates],
  "checks": [commands that must pass after every item: prefer the verified ones above, covering every package the task touches; each must pass on the current code${checkBroker({}) ? `. pi-check is installed: the single entry "pi-check" runs the tests, type checks and lint each item affects in every Go/TypeScript/Python project and ignores failures that already exist on the base branch; prefer ["pi-check"] plus any check it cannot cover (custom scripts)` : ""}],
  "parallel": <how many agent items may run at once, judged from independence and the user's preference; expensive checks have a separate pi-check budget>,
  "model": <optional default exact provider/id from the catalog>, "thinking": <optional supported default level>
- Choose [model: provider/id] and [thinking: level] for each item during planning. Use the least costly model/effort you judge sufficient, not automatically the cheapest: routine localized edits may need less; cross-cutting design, authority/security, migrations and final verification need stronger reasoning. Honor the user's model preferences. Record a short rationale per class of items in rules.md. Do not claim an objectively perfect model or infer speed from price. With no catalog, inherit defaults rather than guess.
- Decide size-escalation/splitting policy upfront in rules.md; automatic increases never override explicit repository/task prohibitions. Resolve approval questions now, not during unattended work.

## 3. Ask
If questions.md has open questions, ask them all here in one message, numbered, each with your recommended answer, and wait. Then record each answer in questions.md ("- [x] Q1: … — Answer: …") and update the brief, maps and items to match. Do not hand off while a question is open.

## 4. Hand off
When every file is written (in an earlier step, not in the same batch of tool calls), call the task_handoff tool on its own with slug "${slug}". It validates the plan, runs the checks once, commits ${W}/ and starts the queue. If it reports problems, fix them and call it again. Then tell the user in two lines what was queued.

## items.md format — one line per item
- [ ] A01 — <what to do, concrete, naming the files/functions>. Done when: <observable result a reviewer can verify>. [areas: <comma-separated folders/files it changes>] [after: <ids it needs finished first>]

Rules for items:
- Each item is done by a fresh agent that has never seen this conversation. It reads AGENTS.md, brief.md, rules.md, the answers in questions.md, and the map/inventory parts the item names. Everything it needs must be there or in the item line.
- Ids: a capital-letter prefix plus a number (A01, A02, B01…), unique. File order breaks ties; actual prerequisites belong in [after].
- Size: one coherent change, normally at most 5 files gaining lines and 150 net added lines. A bigger item is fine when splitting it would be artificial; the queue raises limits on request and splits items that stall.
- [areas: …] is required: the narrowest folders/files the item changes. Items with overlapping areas never run at the same time; disjoint ones run in parallel. Accurate areas mean speed and no conflicts.
- [after: …] only for real dependencies (a helper built in A01 used by A05). Do not chain independent items or add blanket stage barriers. The scheduler prioritizes prerequisites on the longest remaining dependency chain and fills free slots with disjoint ready items. Use [after: *] only for genuinely whole-task verification; otherwise give checks their exact prerequisites.
- Every item must leave the checks passing. No item may depend on an unanswered question.
- Verification goes into [check] items: "- [ ] V01 — Check <what>. Done when: <what must hold>. [check] [areas: <what it verifies>] [after: <the items it verifies>]". A check passes without changes when everything holds; it may fix tests/docs; when it finds production gaps it reports them and the queue adds fix items and checks again. A passed check runs again automatically when an item it covers changes later.
- No "investigate" or "review" items that produce nothing: every item either changes code/docs or is a [check].`;
}

// ---------- handoff ----------

async function handoff(cwd: string, slug: string, ctx: any): Promise<{ ok: boolean; text: string }> {
	const W = `${TASKS_DIR}/${slug}`;
	const task: any = loadJson(taskFile(cwd, slug), null);
	if (!task) return { ok: false, text: `${W}/task.json not found. Is the slug right?` };
	if (runnerPid(cwd) || runnerPid(cwd, "supervisor") || Object.keys(readState(cwd).running ?? {}).length) return { ok: false, text: "A queue/supervisor or interrupted workers still own this repo. Wait for completion or reconcile interrupted work before handing off another task." };

	const problems: string[] = [];
	const warnings: string[] = [];
	const itemsText = readText(join(cwd, W, "items.md"));
	let items;
	try { items = parseQueue(itemsText); }
	catch (e: any) { return { ok: false, text: `Not handed off: ${e.message}` }; }
	if (items.length === 0) problems.push(`${W}/items.md has no "- [ ] ID — …" lines.`);
	const ids = new Map<string, number>();
	for (const i of items as any[]) ids.set(i.id, (ids.get(i.id) ?? 0) + 1);
	const dupes = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
	if (dupes.length) problems.push(`duplicate ids: ${dupes.join(", ")}`);
	const noId = (items as any[]).filter((i) => /^item\d+$/.test(i.id));
	if (noId.length) problems.push(`${noId.length} line(s) do not start with an id like A01, e.g. "${noId[0].line.slice(0, 60)}"`);
	const noDone = (items as any[]).filter((i) => !/Done when:/i.test(i.line));
	if (noDone.length) problems.push(`${noDone.length} item(s) have no "Done when:": ${noDone.slice(0, 6).map((i) => i.id).join(", ")}`);
	const noAreas = (items as any[]).filter((i) => !i.areas?.length);
	if (noAreas.length) problems.push(`${noAreas.length} item(s) have no [areas: …]: ${noAreas.slice(0, 6).map((i) => i.id).join(", ")}`);
	const defaults = { ...readConfig(cwd), ...(task.model !== undefined ? { model: task.model } : {}), ...(task.thinking !== undefined ? { thinking: task.thinking } : {}) };
	const available = ctx?.modelRegistry?.getAvailable?.() ?? [];
	for (const item of items) {
		try {
			const selected = itemConfig(defaults, item);
			const model = selected.model ? available.find((m: any) => `${m.provider}/${m.id}` === selected.model) : ctx?.model;
			if (selected.model && !model) problems.push(`${item.id}: model ${selected.model} is not available/authenticated.`);
			if (selected.thinking && model && !getSupportedThinkingLevels(model).includes(selected.thinking)) problems.push(`${item.id}: ${selected.thinking} is not supported by ${model.provider}/${model.id}.`);
		} catch (e: any) { problems.push(e.message); }
	}
	try { dependencyGraph(items); } catch (e: any) { problems.push(e.message); }
	const openQs = readText(join(cwd, W, "questions.md"))
		.split("\n")
		.filter((l) => /^\s*-\s\[\s\]/.test(l));
	if (openQs.length) problems.push(`${openQs.length} question(s) in questions.md are still open. Ask the user, record the answers ("- [x] … — Answer: …"), then hand off.`);
	for (const f of ["brief.md", "rules.md", "questions.md"]) if (!existsSync(join(cwd, W, f))) problems.push(`${W}/${f} is missing.`);
	const allowed: string[] = Array.isArray(task.allowedPaths) ? task.allowedPaths.filter((p: any) => typeof p === "string" && p.trim()) : [];
	if (allowed.length === 0) problems.push(`task.json has no "allowedPaths".`);
	const outside = (items as any[]).filter((i) => i.areas?.length && !i.areas.every((a: string) => allowed.some((p) => areasOverlap([a], [p]) && a.startsWith(p.split("*")[0].replace(/\/+$/, "")))));
	if (outside.length) warnings.push(`${outside.length} item(s) list areas outside allowedPaths (${outside.slice(0, 4).map((i) => i.id).join(", ")}); their changes there will be rejected.`);
	if (problems.length) return { ok: false, text: `Not handed off yet. Fix these and call task_handoff again:\n- ${problems.join("\n- ")}` };

	// checks: the plan's, else verified ones from setup that cover the allowed paths
	const info: any = loadJson(join(cwd, FLOW_DIR, "repo.json"), null);
	let checks: string[] = Array.isArray(task.checks) ? task.checks.filter((x: any) => typeof x === "string" && x.trim()) : [];
	if (checks.length === 0)
		checks = (info?.checks ?? []).filter((c: any) => c.ok === true && areasOverlap([c.dir === "." ? "" : c.dir], allowed)).map((c: any) => c.cmd);
	if (checks.length === 0) return { ok: false, text: `No checks: add "checks" to task.json (commands that pass on the current code, e.g. a typecheck for each package the task touches), then call task_handoff again.` };
	const failing: string[] = [];
	for (const cmd of checks) {
		ctx?.ui?.setStatus?.("task", `verifying check: ${cmd}`);
		const l = checkLine({}, cmd, cwd);
		if (l.error) {
			failing.push(l.error);
			continue;
		}
		const r = await run(cwd, LOGIN_SHELL, ["-lc", l.line], { timeoutMs: 15 * 60_000 * l.factor, env: cleanEnv() });
		if (r.code !== 0) failing.push(`${cmd} (exit ${r.code})\n${tail(r.out, 20)}`);
	}
	ctx?.ui?.setStatus?.("task", undefined);
	if (failing.length)
		return { ok: false, text: `These checks fail on the current code, so every item would fail. Pick commands that pass today (or fix the command), update task.json, and call task_handoff again:\n\n${failing.join("\n\n")}` };

	// the tree must be clean apart from this task's folder (our own runtime folders are kept out of git first)
	await ensureDir(cwd);
	await exclude(cwd, `${FLOW_DIR}/`);
	const dirty = (await git(cwd, "status", "--porcelain", "--untracked-files=all")).out
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(3).replace(/^"|"$/g, ""))
		.filter((p) => !p.startsWith(`${W}/`));
	if (dirty.length)
		return { ok: false, text: `Uncommitted changes outside ${W}/ (the queue needs a clean tree). Tell the user to commit or stash them, then call task_handoff again:\n- ${dirty.slice(0, 15).join("\n- ")}` };

	// record and commit the plan (worktrees only see committed files)
	task.allowedPaths = allowed;
	task.checks = checks;
	task.status = "queued";
	task.queuedAt = new Date().toISOString();
	task.items = items.length;
	writeFileSync(taskFile(cwd, slug), `${JSON.stringify(task, null, 2)}\n`);
	await git(cwd, "add", "--", W);
	const commit = await git(cwd, "commit", "-m", `task ${slug}: plan (${items.length} items)`, "--", W);
	if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.out)) return { ok: false, text: `Could not commit ${W}/: ${tail(commit.out, 5)}` };

	// archive the previous run's records, keep worktrees (installs are reused)
	await ensureDir(cwd);
	const prev: any = loadJson(join(cwd, DIR, "state.json"), null);
	if (prev) {
		const dest = join(cwd, DIR, "archive", `${readConfig(cwd).task || "previous"}-${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}`);
		mkdirSync(dest, { recursive: true });
		for (const f of ["state.json", "log.md", "notes", "live", "problem.txt", "manager.json", "control"]) {
			if (existsSync(join(cwd, DIR, f))) renameSync(join(cwd, DIR, f), join(dest, f));
		}
	}

	const existing: any = loadJson(join(cwd, DIR, "config.json"), {});
	const parallel = Math.max(1, Math.floor(Number(task.parallel)) || existing.parallel || DEFAULTS.parallel);
	const config = {
		...DEFAULTS,
		...existing,
		queue: `${W}/items.md`,
		task: slug,
		allowedPaths: allowed,
		checks,
		model: defaults.model,
		thinking: defaults.thinking,
		parallel,
		worktrees: parallel > 1 ? true : existing.worktrees ?? DEFAULTS.worktrees,
		setup: info?.install ?? existing.setup ?? "",
		readFirst: `AGENTS.md, ${W}/brief.md, ${W}/rules.md, the answers in ${W}/questions.md, and the parts of ${W}/map/*.md and ${W}/inventory.md this item refers to`,
	};
	writeFileSync(join(cwd, DIR, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

	const err = await startRunner(cwd, true);
	if (err) return { ok: false, text: `The plan is committed, but the queue did not start:\n${err}` };
	// In Pi Web, pin this planning chat while the queue runs: it is the task's control room
	const sid = ctx?.sessionManager?.getSessionId?.();
	if (sid) {
		const web = await piWeb(cwd);
		if (web) await web.ui({ action: "set", ids: [sid], pinned: true }).catch(() => {});
	}
	return {
		ok: true,
		text: `Queued ${items.length} items for task ${slug} (up to ${parallel} in parallel, adaptive). Checks: ${checks.join(" · ")}.${warnings.length ? `\nWarnings: ${warnings.join(" ")}` : ""}\nThe live panel below shows progress; /task status for a summary.`,
	};
}

// ---------- cleanup ----------

async function cleanup(cwd: string, all: boolean, currentSession: string): Promise<string> {
	if (runnerPid(cwd) || runnerPid(cwd, "supervisor") || Object.keys(readState(cwd).running ?? {}).length) return "The queue/supervisor or interrupted workers still own the worktrees. Stop and reconcile them before cleanup.";
	const notes: string[] = [];
	const state = readState(cwd);
	const web = await piWeb(cwd);
	const managerFile = join(cwd, DIR, "manager.json"), manager = loadJson(managerFile, {});
	if (pidAlive(manager.pid)) return "The automatic manager turn is still active; wait before cleanup.";
	if (manager.web && manager.id && web && (await web.running()).runningSessionIds?.includes(manager.id)) return "The automatic manager is still active in Pi Web; wait before cleanup.";
	if (manager.id && manager.id !== currentSession) state.sessions = { ...state.sessions, [manager.id]: { ...state.sessions?.[manager.id], web: !!manager.web, status: "manager" } };
	const rctx = { repo: cwd, state, web, save: () => writeFileSync(join(cwd, DIR, "state.json"), `${JSON.stringify(state, null, 2)}\n`), log: (m: string) => notes.push(m) };

	// item sessions: Pi Web ones through its API, terminal ones by file
	const items = Object.entries(state.sessions ?? {}).filter(([, x]: any) => !x.deleted).map(([id]) => id);
	const webLeft = items.filter((id) => state.sessions[id].web);
	if (webLeft.length && !web) notes.push(`${webLeft.length} item session(s) are in Pi Web, which is not running now; run /task cleanup again with Pi Web open to remove them`);
	const n = items.length ? await deleteSessions(rctx, items) : 0;
	notes.push(n ? `deleted ${n} item/manager session(s)` : "no item sessions left to delete");
	if (state.sessions?.[manager.id]?.deleted) {
		delete manager.id; manager.initialized = false;
		writeFileSync(managerFile, `${JSON.stringify(manager, null, 2)}\n`);
	}

	// planning chats of finished tasks (never the one you are in)
	const fs = flowStatus(cwd);
	const tasks = listTasks(cwd).filter((t: any) => ["done", "finished with failures", "queued (stopped)"].includes(taskStatus(cwd, t)));
	let planned = 0;
	let keptCurrent = false;
	for (const t of tasks) {
		const ids = [...new Set([...(t.planningSessions ?? []), ...(fs[t.slug]?.planningSessions ?? [])])];
		const files: Record<string, string> = fs[t.slug]?.planningFiles ?? {};
		let pending = false;
		for (const id of ids) {
			if (!id) continue;
			if (id === currentSession) {
				keptCurrent = true;
				if (web) await web.ui({ action: "set", ids: [id], pinned: false }).catch(() => {});
				continue;
			}
			let gone = false;
			if (web) gone = await web.del([id]).then((r: any) => (r.deleted ?? []).includes(id) || (r.missing ?? []).includes(id), () => false);
			if (!web && files[id]) {
				rmSync(files[id], { force: true });
				gone = true;
			}
			if (gone) planned++;
			else { pending = true; notes.push(`kept planning chat ${id}: deletion was not confirmed`); }
		}
		if (!pending) setFlowStatus(cwd, t.slug, { status: taskStatus(cwd, t), cleanedAt: new Date().toISOString() });
	}
	if (planned) notes.push(`deleted ${planned} planning chat(s)`);
	if (keptCurrent) notes.push("kept this chat (you are in it); delete it from the sidebar or /resume list when you leave it");

	if (all) {
		const left = Object.values(state.sessions ?? {}).filter((x: any) => !x.deleted).length;
		const root = join(cwd, DIR, "worktrees");
		const wts = existsSync(root) ? readdirSync(root).filter((d) => /^w\d+$/.test(d)) : [];
		const branches = (await git(cwd, "branch", "--list", "queue-failed/*", "--format=%(refname:short)")).out.split("\n").filter(Boolean);
		for (const b of branches) await git(cwd, "branch", "-D", b);
		if (branches.length) notes.push(`deleted ${branches.length} queue-failed/* branches`);
		if (wts.length && left) {
			// Pi Web would show the sessions of a removed worktree as a stray project
			notes.push(`kept the ${wts.length} worktrees: ${left} item session(s) still exist; remove those first`);
		} else if (wts.length) {
			const script = `${wts.map((w) => `git worktree remove --force "${join(root, w)}"; rm -f "${join(root, `${w}.ready`)}"`).join("; ")}; git worktree prune`;
			spawn(LOGIN_SHELL, ["-lc", script], { cwd, detached: true, stdio: "ignore" }).unref();
			notes.push(`removing ${wts.length} worktrees in the background (the next task reinstalls them)`);
		}
	}
	return notes.join("\n");
}

// ---------- manager ----------

/** Queue tools are for you and the manager chat, never for the queue's own item sessions. */
function insideQueueItem(ctx: any): boolean {
	const cwd = String(ctx?.cwd ?? "");
	let name = "";
	try {
		name = ctx?.sessionManager?.getSessionName?.() ?? "";
	} catch {}
	return cwd.includes(`/${DIR}/worktrees/`) || /^queue [A-Za-z0-9-]+:/.test(name);
}

function overviewText(cwd: string): string {
	const cfg: any = readConfig(cwd);
	const state = readState(cwd);
	const items = allItems(readText(join(cwd, cfg.queue || "")), state);
	const by = (pred: (i: any) => boolean) => items.filter(pred);
	const fmt = (i: any, extra = "") => `  ${i.id}${i.check ? " [check]" : ""}${extra} — ${i.title.slice(0, 90)}`;
	const running = Object.values(state.running ?? {}) as any[];
	const failed = by((i) => state.failed[i.key]);
	const parked = by((i) => !state.done[i.key] && !state.failed[i.key] && (state.retried?.[i.key] || state.deferred?.[i.key]));
	const open = by((i) => !state.done[i.key] && !state.failed[i.key] && !state.retried?.[i.key] && !state.deferred?.[i.key]);
	const logTail = readText(join(cwd, DIR, "log.md")).trim().split("\n").slice(-15).join("\n");
	return [
		`task ${cfg.task || "(none)"} · queue ${runnerPid(cwd) ? "RUNNING" : "not running"} · ${items.length} items: passed ${by((i) => state.done[i.key]).length}, failed ${failed.length}, parked ${parked.length}, open ${open.length}`,
		running.length ? `running now:\n${running.map((r) => `  ${r.id} · ${r.doing ?? ""}`).join("\n")}` : "",
		failed.length ? `failed (reason):\n${failed.map((i) => fmt(i, `: ${String(state.failed[i.key]).slice(0, 200)}`)).join("\n")}` : "",
		parked.length ? `parked (conflict or deferred BLOCKED; they run when everything else is done):\n${parked.map((i) => fmt(i, state.deferred?.[i.key] ? " (deferred)" : " (conflict)")).join("\n")}` : "",
		open.length ? `open:\n${open.slice(0, 40).map((i) => fmt(i, i.after?.length ? ` [after: ${i.after.join(", ")}]` : "")).join("\n")}${open.length > 40 ? `\n  … ${open.length - 40} more` : ""}` : "",
		`recent log:\n${logTail}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

async function itemText(cwd: string, id: string): Promise<string> {
	const cfg: any = readConfig(cwd);
	const state = readState(cwd);
	const item: any = allItems(readText(join(cwd, cfg.queue || "")), state).find((i: any) => i.id === id);
	if (!item) return `No item ${id} in the queue.`;
	const status = state.done[item.key] ? `passed (${state.done[item.key]})` : state.failed[item.key] ? `failed: ${state.failed[item.key]}` : state.deferred?.[item.key] ? "deferred" : state.retried?.[item.key] ? "parked after a conflict" : "open";
	const note = readText(join(cwd, DIR, "notes", `${id}.md`)).trim().slice(0, 3000);
	const live = readText(join(cwd, DIR, "live", `${id}.log`)).trim().split("\n").slice(-20).join("\n");
	const sha = state.done[item.key];
	const diff = sha && sha !== "checked" ? (await git(cwd, "show", "--stat", "--format=%h %s", sha)).out.trim().slice(0, 2000) : "";
	return [`${item.line}`, `status: ${status}`, diff ? `commit:\n${diff}` : "", note ? `last result:\n${note}` : "", live ? `activity:\n${live}` : ""].filter(Boolean).join("\n\n");
}

/** Persist controls in one inbox; only the runner mutates queue state. */
async function control(cwd: string, ctl: any): Promise<string> {
	if (ctl.action === "pause") {
		mkdirSync(join(cwd, DIR), { recursive: true });
		writeFileSync(join(cwd, DIR, "PAUSE"), "");
		return runnerPid(cwd) ? "Pausing dispatch: running items finish normally; no new items start." : "The queue is not running.";
	}
	if (ctl.action === "stop") {
		mkdirSync(join(cwd, DIR), { recursive: true });
		writeFileSync(join(cwd, DIR, "STOP"), "");
		return runnerPid(cwd) ? "Stopping: running items stop within seconds; their work is kept on queue-failed/ branches." : "The queue is not running.";
	}
	if (ctl.action === "start") {
		if (runnerPid(cwd)) return "The queue is already running.";
		const err = await startRunner(cwd, true);
		return err ? `The queue did not start:\n${err}` : "Queue started.";
	}
	const cfg: any = readConfig(cwd);
	enqueueControl(cwd, { ...ctl, task: cfg.task, by: "user" });
	return `${ctl.action} queued; ${runnerPid(cwd) ? "the runner applies it within seconds" : "it applies on the next start"}.`;
}

function managerPrompt(cwd: string): string {
	const cfg: any = readConfig(cwd);
	return `You are now the MANAGER of this repo's work queue${cfg.task ? ` (task ${cfg.task}, plan in .tasks/${cfg.task}/)` : ""}. You act only on what I ask in each message; you never start work on your own.

The pi-flow skill (references/manager.md, items.md, troubleshooting.md) explains every action and the usual causes of failures; read it when unsure.

Your tools: queue_overview (status, failures with reasons, parked/open items, recent log), queue_item (one item: its line, status, commit, last result, activity), queue_control (stop, start, retry, recheck, rerun, unpark, add, parallel).

How to help me:
- When I ask what is wrong: read the overview and the failing items, find the real cause (often several failures share one cause, or a check ran before the work it checks), and explain it in a few lines with what you would do.
- When I ask you to act: say what you will do, do it with queue_control, then show the result. retry = run failed/parked items again; recheck = run passed [check] items again; rerun = run passed items again; unpark = let parked items run normally and in parallel; next = run these items next; add = new items in the work-list format (only when I agreed to them); parallel = how many run at once, also while running (my number becomes the ceiling).
- Never edit code, revert commits or delete branches. If something needs that, tell me.

Start with a short overview of where things stand and anything that needs my attention.`;
}

// exported for tests
export { cleanup, handoff, planPrompt, control, startRunner };

// ---------- the extension ----------

export default function (pi: ExtensionAPI) {
	let watch: ReturnType<typeof setInterval> | undefined;
	function stopWatch(ctx?: any) {
		clearInterval(watch);
		watch = undefined;
		try {
			ctx?.ui.setWidget("queue", undefined);
		} catch {}
	}
	function startWatch(ctx: any) {
		stopWatch();
		if (!ctx.hasUI) return;
		const cwd = ctx.cwd;
		const tick = () => {
			try {
				ctx.ui.setWidget("queue", liveLines(cwd));
			} catch {
				stopWatch();
			}
		};
		tick();
		watch = setInterval(tick, 4000);
		watch.unref?.();
	}
	pi.on("session_shutdown", async (_event, ctx) => stopWatch(ctx));

	pi.registerTool({
		name: "task_handoff",
		label: "Hand task to queue",
		description:
			"Hand a planned task to the queue: validates .tasks/<slug>/ (items, questions answered, allowedPaths, checks), runs the checks once, commits the plan and starts the queue. Call it only when planning is complete and every question is answered.",
		promptSnippet: "task_handoff: validate a planned task and start its queue",
		parameters: Type.Object({ slug: Type.String({ description: "The task slug (folder name under .tasks/)" }) }),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const blocked = guard(ctx);
			if (blocked) return blocked;
			const r = await handoff(ctx.cwd, String(params.slug).trim(), ctx);
			if (r.ok) startWatch(ctx);
			return { content: [{ type: "text", text: r.text }], details: { ok: r.ok } };
		},
	} as any);

	const guard = (ctx: any) => (insideQueueItem(ctx) ? { content: [{ type: "text", text: "Queue tools are not available inside a queue item. Finish the item or reply BLOCKED." }], details: {} } : null);

	pi.registerTool({
		name: "queue_overview",
		label: "Queue overview",
		description: "The work queue's state: counts, running items, failed items with reasons, parked and open items, recent log. Use it when the user asks about the queue or the task's progress.",
		promptSnippet: "queue_overview: where the task queue stands",
		parameters: Type.Object({}),
		async execute(_id: string, _p: any, _s: any, _u: any, ctx: any) {
			return guard(ctx) ?? { content: [{ type: "text", text: overviewText(ctx.cwd) }], details: {} };
		},
	} as any);

	pi.registerTool({
		name: "queue_item",
		label: "Queue item",
		description: "One queue item in detail: its line, status, commit, last result and recent activity.",
		promptSnippet: "queue_item: details of one queue item",
		parameters: Type.Object({ id: Type.String({ description: "Item id, e.g. P03 or V04f" }) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			return guard(ctx) ?? { content: [{ type: "text", text: await itemText(ctx.cwd, String(p.id).trim()) }], details: {} };
		},
	} as any);

	pi.registerTool({
		name: "queue_control",
		label: "Control queue",
		description:
			"Change the work queue, only when the user asked for it: pause (stop dispatch, let running items finish) | stop (abort running items) | start | retry (failed/parked items run again) | recheck (passed [check] items run again) | rerun (passed items run again) | unpark (parked/deferred items run normally, in parallel) | next (run these items next: un-parks them and puts them first) | add (new work-list lines, only ones the user agreed to) | parallel (value = how many at once, becomes the ceiling; works while running). ids are item ids or prefixes (e.g. V04 matches V04a…V04h); empty ids = all.",
		promptSnippet: "queue_control: pause/stop/start/retry/recheck/rerun/unpark/next/add/parallel (only when the user asks)",
		parameters: Type.Object({
			action: Type.Union(["pause", "stop", "start", "retry", "recheck", "rerun", "unpark", "next", "add", "parallel"].map((a) => Type.Literal(a))),
			ids: Type.Optional(Type.Array(Type.String())),
			lines: Type.Optional(Type.Array(Type.String({ description: "Work-list lines: A01 — what. Done when: … [areas: …] [after: …]" }))),
			value: Type.Optional(Type.Number()),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			return guard(ctx) ?? { content: [{ type: "text", text: await control(ctx.cwd, p) }], details: {} };
		},
	} as any);

	pi.registerCommand("task", {
		description: "Plan and run a large task: /task <request> | manage | setup | status | resume <slug> | cleanup [--all] | save-profile",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const text = (args ?? "").trim();
			const [cmd = "", ...rest] = text.split(/\s+/);

			if (!text || cmd === "help") {
				ctx.ui.notify(
					"/task <what you want done>   plan it here; it asks its questions, then starts the queue\n/task manage   make this chat the queue manager: ask it what is wrong, tell it to retry/recheck/rerun\n/task setup   once per repo (plugins, verified checks, AGENTS.md)\n/task status   tasks and the queue\n/task resume <slug>   continue planning in this session\n/task cleanup [--all]   delete finished task sessions (--all: worktrees, failed branches too)\n/task save-profile   use this repo's plugins as the profile for /task setup",
					"info",
				);
				return;
			}

			if (cmd === "setup") {
				ctx.ui.notify("task setup: started. Plugins, AGENTS.md, then every check command runs once (a few minutes).", "info");
				const setStatus = (s?: string) => {
					try {
						ctx.ui.setStatus("task", s ? `setup: ${s}` : undefined);
					} catch {}
				};
				setupRepo(cwd, setStatus)
					.then((r: any) => {
						setStatus();
						ctx.ui.notify(
							`task setup: done. ${r.ok} check(s) pass, ${r.bad} fail.\n${r.notes.map((n: string) => `- ${n}`).join("\n")}\nFull report: ${FLOW_DIR}/setup-report.md`,
							r.bad ? "warning" : "info",
						);
					})
					.catch((e: any) => {
						setStatus();
						ctx.ui.notify(`task setup failed: ${e?.message ?? e}`, "error");
					});
				return;
			}

			if (cmd === "save-profile") {
				try {
					const r = saveProfile(cwd);
					ctx.ui.notify(`task: saved ${r.count} project plugin(s) as your profile (${r.file}). /task setup installs them in other repos.`, "info");
				} catch (e: any) {
					ctx.ui.notify(`task: could not save the profile: ${e?.message ?? e}`, "error");
				}
				return;
			}

			if (cmd === "status" || cmd === "list") {
				const tasks = listTasks(cwd);
				const rows = tasks.map((t: any) => {
					const items = parseQueue(readText(join(cwd, TASKS_DIR, t.slug, "items.md"))).length;
					const open = readText(join(cwd, TASKS_DIR, t.slug, "questions.md"))
						.split("\n")
						.filter((l) => /^\s*-\s\[\s\]/.test(l)).length;
					return `- ${t.slug} · ${taskStatus(cwd, t)}${items ? ` · ${items} items` : ""}${open ? ` · ${open} open questions` : ""}`;
				});
				ctx.ui.notify(`${rows.join("\n") || "No tasks yet. /task <request> to plan one."}\n\n${liveLines(cwd).join("\n")}`, "info");
				return;
			}

			if (cmd === "manage" || cmd === "manager") {
				try {
					pi.setSessionName(`manager${readConfig(cwd).task ? ` · ${readConfig(cwd).task}` : ""}`);
				} catch {}
				const web = await piWeb(cwd);
				if (web) await web.ui({ action: "set", ids: [ctx.sessionManager.getSessionId()], pinned: true }).catch(() => {});
				startWatch(ctx);
				await ctx.waitForIdle();
				pi.sendUserMessage(managerPrompt(cwd));
				return;
			}

			if (cmd === "cleanup") {
				const msg = await cleanup(cwd, rest.includes("--all"), ctx.sessionManager.getSessionId());
				ctx.ui.notify(`task cleanup:\n${msg}`, "info");
				return;
			}

			let slug: string;
			let request: string;
			if (cmd === "resume") {
				slug = rest[0] ?? "";
				const t: any = loadJson(taskFile(cwd, slug), null);
				if (!t) {
					ctx.ui.notify(`task: no task "${slug}". /task status lists them.`, "warning");
					return;
				}
				if (t.status !== "planning") {
					ctx.ui.notify(`task ${slug} was already handed to the queue (${taskStatus(cwd, t)}). /queue status, or /queue retry + /queue start for failed items.`, "warning");
					return;
				}
				request = t.request;
				t.planningSessions = [...new Set([...(t.planningSessions ?? []), ctx.sessionManager.getSessionId()])];
				writeFileSync(taskFile(cwd, slug), `${JSON.stringify(t, null, 2)}\n`);
			} else {
				if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).out.trim() !== "true") {
					ctx.ui.notify("task: this folder is not a git repository.", "error");
					return;
				}
				request = text;
				await ensureDir(cwd);
				await exclude(cwd, `${FLOW_DIR}/`);
				slug = makeSlug(cwd, request);
				mkdirSync(join(cwd, TASKS_DIR, slug, "map"), { recursive: true });
				writeFileSync(
					taskFile(cwd, slug),
					`${JSON.stringify({ slug, request, createdAt: new Date().toISOString(), status: "planning", planningSessions: [ctx.sessionManager.getSessionId()] }, null, 2)}\n`,
				);
			}
			const sid = ctx.sessionManager.getSessionId();
			const prevFs = flowStatus(cwd)[slug] ?? {};
			const sfile = ctx.sessionManager.getSessionFile?.();
			setFlowStatus(cwd, slug, {
				planningSessions: [...new Set([...(prevFs.planningSessions ?? []), sid])],
				planningFiles: { ...(prevFs.planningFiles ?? {}), ...(sfile ? { [sid]: sfile } : {}) },
			});
			try {
				pi.setSessionName(`task ${slug}: plan`);
			} catch {}
			if (!existsSync(join(cwd, FLOW_DIR, "repo.json")))
				ctx.ui.notify("task: /task setup has not run in this repo, so no checks are verified yet. Planning anyway; the plan will pick its own checks.", "warning");
			ctx.ui.notify(`task ${slug}: planning in this session. It will ask its questions here, then start the queue.`, "info");
			await ctx.waitForIdle();
			const prompt = planPrompt(cwd, slug, request, ctx.modelRegistry.getAvailable());
			pi.sendUserMessage(cmd === "resume" ? `Continue planning task ${slug}: read ${TASKS_DIR}/${slug}/ (what exists so far), then carry on with the steps below.\n\n${prompt}` : prompt);
		},
	});

	pi.registerCommand("queue", {
		description: "Control the task queue: /queue start | stop | status | watch [off] | log <id> | open <id> | retry [id] | recheck [id] | rerun <id> | unpark | next <ids> | parallel <n> | problem",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const [cmd = "status", arg] = (args ?? "").trim().split(/\s+/).filter(Boolean);

			if (cmd === "watch") {
				if (arg === "off") {
					stopWatch(ctx);
					ctx.ui.notify("queue: live panel off.", "info");
				} else {
					startWatch(ctx);
					ctx.ui.notify("queue: live panel on. /queue watch off hides it.", "info");
				}
				return;
			}
			if (cmd === "status") {
				const p = runnerPid(cwd) ? "" : problemText(cwd);
				ctx.ui.notify(`${liveLines(cwd).join("\n")}${p ? `\n\nLast problem:\n${p}` : ""}`, "info");
				return;
			}
			if (cmd === "log" || cmd === "open") {
				const state = readState(cwd);
				const id = (arg ?? "").trim();
				const entries = Object.entries(state.sessions ?? {}).filter(([, x]: any) => x.item === id);
				if (!id) {
					ctx.ui.notify(`Usage: /queue ${cmd} <item id>, e.g. /queue ${cmd} A01`, "warning");
					return;
				}
				if (cmd === "log") {
					const live = readText(join(cwd, DIR, "live", `${id}.log`)).trim().split("\n").slice(-25).join("\n");
					const note = readText(join(cwd, DIR, "notes", `${id}.md`)).trim();
					ctx.ui.notify(`${id} activity:\n${live || "(nothing yet)"}${note ? `\n\n${note.slice(0, 1500)}` : ""}`, "info");
					return;
				}
				const [sid, info]: any = entries.at(-1) ?? [];
				if (!sid) {
					ctx.ui.notify(`queue: no session recorded for ${id} yet.`, "warning");
					return;
				}
				if (info.deleted) {
					ctx.ui.notify(`queue: ${id}'s session was already cleaned up. Its result is in .pi-queue/notes/${id}.md.`, "info");
					return;
				}
				if (info.web) {
					ctx.ui.notify(`queue: ${id} runs in Pi Web — open "queue ${id}: …" in the sidebar (it stays live there).`, "info");
					return;
				}
				if (info.status === "running") {
					ctx.ui.notify(`queue: ${id} is still running in the background; /queue log ${id} shows what it is doing. Open it once it has finished.`, "info");
					return;
				}
				const file = sessionFiles(cwd, [sid])[sid];
				if (!file) {
					ctx.ui.notify(`queue: ${id}'s session file was not found.`, "warning");
					return;
				}
				stopWatch(ctx);
				const switched = await ctx.switchSession(file);
				if (switched.cancelled) ctx.ui.notify(`queue: session switch cancelled or unsupported by this host. Open it from the session list, or run pi --session ${JSON.stringify(file)} in a terminal.`, "info");
				return;
			}
			if (cmd === "problem") {
				ctx.ui.notify(problemText(cwd, 200) || "queue: no recorded problem.", "info");
				return;
			}
			if (["stop", "pause", "recheck", "rerun", "unpark", "parallel", "retry", "next"].includes(cmd)) {
				const ids = (args ?? "").trim().split(/[\s,]+/).filter(Boolean).slice(1);
				ctx.ui.notify(`queue: ${await control(cwd, cmd === "parallel" ? { action: cmd, value: Number(arg) } : { action: cmd, ids })}`, "info");
				return;
			}
			if (cmd !== "start") {
				ctx.ui.notify("Usage: /queue start | stop | status | watch [off] | log <id> | open <id> | retry [id] | recheck [id] | rerun <id> | unpark | next <ids> | parallel <n> | problem", "warning");
				return;
			}
			const pid = runnerPid(cwd);
			if (pid) {
				startWatch(ctx);
				ctx.ui.notify(`queue: already running (pid ${pid}). /queue stop to end.`, "info");
				return;
			}
			if (!existsSync(join(cwd, DIR, "config.json")) || !readConfig(cwd).queue) {
				ctx.ui.notify("queue: nothing queued yet. Plan a task with /task <request>; it starts the queue itself.", "warning");
				return;
			}
			const err = await startRunner(cwd, true);
			if (!err) startWatch(ctx);
			ctx.ui.notify(err ? `queue: the runner stopped right away.\n${err}` : `queue: started.\n${liveLines(cwd).join("\n")}`, err ? "error" : "info");
		},
	});
}
