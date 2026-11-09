#!/usr/bin/env node
// Owns queue supervision outside the runner. Healthy ticks never prompt a model.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIR, acquireProcessLock, allItems, approvedTask, enqueueControl, ensureDir, findPiWeb, loadJson, piTurn, pidAlive, readConfig, resolvePi, saveJson, validateRecovery, webClient, webTurn } from "./runner.mjs";

export { approvedTask };

export const HEALTH_TICK_MS = 60000;
const REVIEW_BACKOFF_MS = 5000;
const MAX_REVIEW_ATTEMPTS = 2;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

export function assessHealth(state, items, { running, stopped, paused }) {
	if (stopped || paused) return "manual";
	if (!running && Object.keys(state.running ?? {}).length) return "blocked";
	// A clean crash can strand unrelated open work even when old failures exhausted recovery.
	if (!running && state.startedAt && state.phase === "running items" && items.some((i) => !state.done?.[i.key] && !state.failed?.[i.key])) return "crashed";
	if (state.startedAt && items.some((i) => state.failed?.[i.key])) return "failed";
	if (Object.values(state.running ?? {}).some((r) => !r || r.quarantined || (!r.id && !r.key))) return "blocked";
	if (running) return "healthy"; // quiet checks and provider retries are not evidence of a hang
	if (!state.startedAt || ["starting", "diagnosing the failed baseline", ""].includes(state.phase)) return "blocked";
	if (items.every((i) => state.done?.[i.key])) return "complete";
	return state.phase === "running items" ? "crashed" : "blocked";
}

/** The runner repeats this boundary when consuming the durable inbox. */
export function validateProposal(proposal, state, items, manager, health, c = {}) {
	if (proposal?.action === "wait") return undefined;
	if (typeof proposal?.reason !== "string" || !proposal.reason.trim()) throw new Error("manager must explain its diagnosis");
	if (proposal.action === "restart" && health === "crashed" && !Object.keys(state.running ?? {}).length && (manager.restarts ?? 0) < (c.recovery?.maxRestarts ?? 2)) return { action: "restart", reason: proposal.reason.slice(0, 3000) };
	if (!["retry", "repair"].includes(proposal.action) || health !== "failed" || !Array.isArray(proposal.ids) || !proposal.ids.length) throw new Error("manager action is not permitted");
	return validateRecovery(proposal, state, items, manager, c);
}

function managerPrompt(repo, c, state, items, health, manager) {
	const folder = join(repo, ".tasks", c.task);
	const failures = items.filter((i) => state.failed?.[i.key]);
	const repair = c.recovery?.maxRepairs > (manager.repairs ?? 0);
	const repairRule = repair ? `You may also propose repair for exactly ONE failed original, non-derived parent: 1–3 narrowly scoped work-item lines, each with Done when: and concrete [areas: ...], restricted to the parent's areas and allowed paths. No model, thinking, size, check or after tags are allowed. Fresh repair workers perform targeted diagnostics AND fixes, never diagnostic subagents. The runner assigns parent-repairN IDs and inherits the parent's model, thinking, limits and checks. At most ${c.recovery.maxRepairs} repair items per task.` : "Do not propose new items or repair actions; only existing-item retries are approved.";
	return `You are the automatic manager of approved task ${c.task}. The questions were answered and the queue started. You have NO tools and cannot edit code, run commands, spawn diagnostic subagents, weaken checks, change models, or expand scope. Workers implement repairs; the supervisor validates your proposal.

Diagnose the supplied evidence. Healthy/complete/manual/blocked states require wait. For failed work, propose retry only when a fresh worker can fix the original item within its original scope, using your specific diagnosis. Never retry unchanged missing credentials, decisions, contracts or safety blockers. At most ${c.recovery?.maxAttempts ?? 2} recovery attempts per parent and ${c.recovery?.maxRestarts ?? 2} clean runner restarts per task. Independent workers may still be running: target only the supplied non-running failures. Group related failures. ${repairRule}

End with ONE line: CONTROL: {"action":"wait","reason":"..."}, CONTROL: {"action":"retry","ids":["A01"],"reason":"specific diagnosis and repair guidance"}, or CONTROL: {"action":"restart","reason":"..."} (only a crashed runner with no remaining workers).${repair ? '\nRepair form: CONTROL: {"action":"repair","ids":["A01"],"lines":["Fix the evidenced bug. Done when: focused check passes. [areas: parent/path]"],"reason":"specific evidence and fix"}' : ""}

Health: ${health}; phase: ${state.phase}; passed: ${Object.keys(state.done ?? {}).length}; recovery attempts: ${JSON.stringify(manager.attempts ?? {})}; restarts: ${manager.restarts ?? 0}; repair items used: ${manager.repairs ?? 0}.
Allowed paths: ${JSON.stringify(c.allowedPaths)}
Checks (must not be weakened): ${JSON.stringify(c.checks)}
Brief: ${text(join(folder, "brief.md")).slice(0, 4000)}
Rules: ${text(join(folder, "rules.md")).slice(0, 4000)}
Answers: ${text(join(folder, "questions.md")).slice(0, 4000)}
Failures (${failures.length}; first 8):
${failures.slice(0, 8).map((i) => `${i.line}\nFailure: ${state.failed[i.key]}\n${text(join(repo, DIR, "notes", `${i.id}.md`)).slice(-6000)}`).join("\n\n")}
Problem: ${text(join(repo, DIR, "problem.txt")).slice(-4000)}`;
}

export async function supervise(repo, { tickMs = HEALTH_TICK_MS, reviewBackoffMs = REVIEW_BACKOFF_MS, resume = false } = {}) {
	await ensureDir(repo);
	const release = acquireProcessLock(join(repo, DIR, "supervisor.pid"));
	const log = (message) => appendFileSync(join(repo, DIR, "log.md"), `- ${new Date().toISOString()} MANAGER ${message}\n`);
	const stopped = () => existsSync(join(repo, DIR, "STOP"));
	const paused = () => existsSync(join(repo, DIR, "PAUSE"));
	const runnerAlive = () => pidAlive(Number(text(join(repo, DIR, "runner.pid"))));
	const onSignal = () => writeFileSync(join(repo, DIR, "STOP"), "supervisor signal");
	const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
	for (const sig of signals) process.on(sig, onSignal);
	process.on("exit", release);
	let child, childExited = true, launchedFromRunId, wakePending = false, wakeWaiter;
	const wake = () => { wakePending = true; wakeWaiter?.(); };
	const launch = () => {
		if (stopped() || paused() || runnerAlive() || !childExited) return;
		launchedFromRunId = loadJson(join(repo, DIR, "state.json"), {}).runId;
		childExited = false;
		child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "runner.mjs"), repo], { cwd: repo, stdio: ["ignore", "inherit", "inherit", "ipc"] });
		// Latch events even during a model turn: a one-shot wait listener loses these wakes.
		child.on("message", wake);
		child.once("exit", () => { childExited = true; wake(); });
		child.on("error", (e) => { childExited = true; log(`runner launch failed: ${e.message}`); wake(); });
	};
	const wait = (ms = tickMs) => new Promise((resolve) => {
		if (wakePending) { wakePending = false; resolve(); return; }
		const done = () => { clearTimeout(timer); wakeWaiter = undefined; wakePending = false; resolve(); };
		const timer = setTimeout(done, ms);
		wakeWaiter = done;
	});
	const manualPending = (task) => {
		const dir = join(repo, DIR, "control");
		return existsSync(dir) && readdirSync(dir).some((f) => {
			const ctl = f.endsWith(".json") && loadJson(join(dir, f), {});
			return ctl && ctl.task === task && ctl.by !== "auto";
		});
	};
	const inboxHas = (control) => {
		const dir = join(repo, DIR, "control");
		return existsSync(dir) && readdirSync(dir).some((f) => {
			if (!f.endsWith(".json")) return false;
			const ctl = loadJson(join(dir, f), {});
			return ctl.by === "auto" && ctl.task === control.task && ctl.approval === control.approval && ctl.action === control.action && hash([ctl.ids, ctl.failures, ctl.lines, ctl.reason]) === hash([control.ids, control.failures, control.lines, control.reason]);
		});
	};
	try {
		const c = readConfig(repo), approval = approvedTask(repo, c);
		const initial = loadJson(join(repo, DIR, "state.json"), {});
		if (resume && Object.keys(initial.running ?? {}).length) { log("NOT STARTED: interrupted workers remain; worktrees preserved"); return; }
		// Explicit start grants one initial launch, without resetting automatic budgets.
		// Without it, a clean crash still needs a budgeted restart proposal.
		const manualInbox = manualPending(c.task);
		const resumable = initial.startedAt && initial.phase !== "running items" && !Object.keys(initial.running ?? {}).length && allItems(text(join(repo, c.queue)), initial).some((i) => !initial.done?.[i.key] && !initial.failed?.[i.key]);
		if (resume || !initial.startedAt || manualInbox || resumable || c.manager === false || !approval) launch();
		if (c.manager === false || !approval) { while (!childExited || runnerAlive()) await wait(); return; }
		const file = join(repo, DIR, "manager.json");
		let manager = loadJson(file, {});
		if (manager.task !== c.task) manager = { task: c.task, approval, attempts: {}, restarts: 0, repairs: 0 };
		manager.attempts ??= {};
		manager.reviews ??= {};
		manager.dispatches ??= [];
		if (manager.approval !== approval) { log("approval changed; automatic management disabled"); return; }
		let web = null;
		if (c.runIn !== "cli") {
			const found = await findPiWeb(c);
			if (found.url) web = webClient({ ...c, piWebUrl: found.url });
			else if (c.runIn === "web") { log("Pi Web unavailable; manager not started, no CLI fallback"); return; }
		}
		if (manager.web !== undefined && manager.web !== !!web) { log("manager backend unavailable/changed; no automatic fallback"); return; }
		manager.web = !!web;
		const ref = { id: manager.id || (web ? undefined : randomUUID()) };
		const save = () => { manager.id = ref.id; saveJson(file, manager); };
		save();
		const authorized = () => !stopped() && !paused() && readConfig(repo).manager !== false && approvedTask(repo, readConfig(repo)) === approval;
		const ctx = { repo, c, web, pi: await resolvePi(c), env: process.env, manager: true, stopRequested: () => !authorized(), onWorker: (identity) => {
			if (identity.sessionId) ref.id = identity.sessionId;
			manager.pid = identity.pid;
			save();
			if (web && ref.id) web.ui({ action: "set", ids: [ref.id], pinned: true }).catch(() => {});
		} };
		const managerBusy = async () => {
			if (pidAlive(manager.pid)) return true;
			try { return !!(web && ref.id && (await web.running()).runningSessionIds?.includes(ref.id)); }
			catch (e) { log(`manager ownership unavailable: ${e.message}`); return true; }
		};
		while (true) {
			if (!authorized()) { log("manual intent or task/config changed; supervision stopped"); break; }
			const state = loadJson(join(repo, DIR, "state.json"), {});
			// Do not review the old run's terminal snapshot while a fresh runner is starting.
			if (!childExited && state.runId === launchedFromRunId) { await wait(); continue; }
			const items = allItems(text(join(repo, c.queue)), state);
			const running = runnerAlive() || !childExited;
			if (running && manualPending(c.task)) { await wait(); continue; }
			const health = assessHealth(state, items, { running, stopped: stopped(), paused: paused() });
			// A runner can exit between its final inbox read and our enqueue. Launch once for
			// that dispatch after it really exits, never reset state or consume controls here.
			const dispatchCount = manager.dispatches.length;
			manager.dispatches = manager.dispatches.filter(({ control }) => inboxHas(control));
			if (manager.dispatches.length !== dispatchCount) save();
			const dispatch = manager.dispatches.find((d) => !d.launched);
			if (dispatch && !running && !Object.keys(state.running ?? {}).length) {
				dispatch.launched = true;
				save(); launch(); await wait(); continue;
			}
			const incidents = [];
			if (health === "failed") {
				for (const item of items) {
					if (!state.failed?.[item.key] || manager.dispatches.some(({ control }) => control.ids.includes(item.id))) continue;
					try { validateProposal({ action: "retry", ids: [item.id], reason: "Admission check" }, state, items, manager, health, c); }
					catch { continue; } // no model turns for blockers, active/quarantined or exhausted targets
					incidents.push({ item, token: hash([item.key, state.failed[item.key], manager.attempts[item.id] ?? 0]) });
				}
			} else if (health === "crashed" && (manager.restarts ?? 0) < (c.recovery?.maxRestarts ?? 2)) {
				incidents.push({ token: hash(["crashed", state.runId, manager.restarts ?? 0]) });
			}
			const pending = incidents.filter(({ token }) => !manager.reviews[token]?.done && (manager.reviews[token]?.count ?? 0) < MAX_REVIEW_ATTEMPTS);
			const review = pending.filter(({ token }) => (manager.reviews[token]?.nextAt ?? 0) <= Date.now()).slice(0, 8);
			if (!review.length) {
				if (!running && !pending.length && !await managerBusy()) break;
				const nextAt = Math.min(...pending.map(({ token }) => manager.reviews[token]?.nextAt ?? Date.now()));
				await wait(Math.max(1, Math.min(tickMs, nextAt - Date.now())));
				continue;
			}
			if (await managerBusy()) { await wait(); continue; } // defer, do not abandon unhandled incidents
			if (!authorized()) continue;
			for (const { token } of review) {
				const record = manager.reviews[token] ??= { count: 0 };
				record.count++;
				// Reserve before prompting: crashes and failed reviews cannot create a hot loop.
				record.nextAt = Date.now() + Math.min(HEALTH_TICK_MS, Math.max(1, reviewBackoffMs) * 2 ** (record.count - 1));
			}
			manager.lastReviewAt = Date.now();
			save();
			const prompt = managerPrompt(repo, c, state, review.flatMap(({ item }) => item ? [item] : []), health, manager);
			let result;
			try { result = await (web ? webTurn(ctx, repo, ref, `manager · ${c.task}`, prompt, 10) : piTurn(ctx, repo, ref.id, `manager · ${c.task}`, prompt, 10)); }
			catch (e) { result = { status: "error", err: e.message, quiescent: false }; }
			manager.reply = String(result.reply || result.err || "").slice(-12000);
			if (result.quiescent !== false) manager.pid = undefined;
			// Backoff starts after the failed turn, not before a potentially long review.
			for (const { token } of review) {
				const record = manager.reviews[token];
				record.nextAt = Date.now() + Math.min(HEALTH_TICK_MS, Math.max(1, reviewBackoffMs) * 2 ** (record.count - 1));
			}
			save();
			if (!authorized()) continue;
			if (result.status !== "ok" || result.quiescent === false) { log(`review failed: ${result.err || result.status}`); continue; }
			const latest = loadJson(join(repo, DIR, "state.json"), {});
			if (latest.runId !== state.runId) continue;
			const latestItems = allItems(text(join(repo, c.queue)), latest);
			const latestRunning = runnerAlive() || !childExited;
			const latestHealth = assessHealth(latest, latestItems, { running: latestRunning });
			try {
				const line = String(result.reply).split("\n").filter((l) => l.startsWith("CONTROL:")).at(-1);
				const proposal = JSON.parse(line?.slice(8) ?? "null");
				if (proposal?.action === "wait") {
					for (const { token } of review) manager.reviews[token].done = true;
					save(); continue;
				}
				if (proposal?.action !== "restart") {
					for (const id of proposal?.ids ?? []) {
						const selected = review.find(({ item }) => item?.id === id);
						if (!selected || latest.failed?.[selected.item.key] !== state.failed[selected.item.key]) throw new Error(`${id}: selected failure changed during review`);
					}
				}
				// Only selected snapshots must match. Concurrent independent failures remain pending.
				const action = validateProposal(proposal, latest, latestItems, manager, latestHealth, c);
				if (!action) continue;
				if (action.action === "restart") {
					if (health !== "crashed" || latestRunning || Object.keys(latest.running ?? {}).length) throw new Error("runner/worker ownership changed");
					manager.restarts = (manager.restarts ?? 0) + 1;
					for (const { token } of review) manager.reviews[token].done = true;
					save(); launch();
				} else {
					if (!latestRunning && Object.keys(latest.running ?? {}).length) throw new Error("orphaned worker ownership");
					const failures = {};
					mkdirSync(join(repo, DIR, "notes"), { recursive: true });
					for (const id of action.ids) {
						const selected = review.find(({ item }) => item?.id === id);
						manager.attempts[id] = (manager.attempts[id] ?? 0) + 1;
						failures[id] = state.failed[selected.item.key];
						manager.reviews[selected.token].done = true;
						appendFileSync(join(repo, DIR, "notes", `${id}.md`), `\n\n## Manager diagnosis\n${action.reason}\n`);
					}
					if (action.action === "repair") manager.repairs = (manager.repairs ?? 0) + action.lines.length;
					const control = { task: c.task, by: "auto", approval, action: action.action, ids: action.ids, lines: action.lines, failures, reason: action.reason };
					manager.dispatches.push({ control, launched: false });
					save(); // persist dedup AND budgets before dispatch; the runner is the only state writer
					enqueueControl(repo, control);
				}
				for (const { token } of review) {
					const record = manager.reviews[token];
					if (!record.done) record.count--; // an unselected incident has not failed review
					record.nextAt = 0;
				}
				save();
				log(`${action.action} ${action.ids?.join(", ") ?? "runner"}`);
			} catch (e) { log(`proposal not applied: ${e.message}`); }
			// Re-read immediately after every turn, even if IPC arrived while the model was busy.
		}
	} finally {
		// Keep ownership until the child drains, including manual pause/stop and startup failures.
		while (!childExited) await wait();
		for (const sig of signals) process.off(sig, onSignal);
		process.off("exit", release);
		release();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) supervise(process.argv[2] || process.cwd(), { resume: process.argv.slice(3).includes("--resume") }).catch((e) => { console.error(e); process.exitCode = 1; });
