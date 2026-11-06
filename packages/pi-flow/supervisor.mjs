#!/usr/bin/env node
// Owns queue supervision outside the runner. Healthy ticks never prompt a model.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIR, acquireProcessLock, allItems, enqueueControl, ensureDir, findPiWeb, loadJson, piTurn, pidAlive, readConfig, resolvePi, saveJson, webClient, webTurn } from "./runner.mjs";

export const HEALTH_TICK_MS = 60000;
const REVIEW_COOLDOWN_MS = 600000;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

export function approvedTask(repo, c) {
	if (!c.task || basename(c.task) !== c.task || [".", ".."].includes(c.task)) return undefined;
	const folder = join(repo, ".tasks", c.task);
	const task = loadJson(join(folder, "task.json"), {});
	const files = ["task.json", "brief.md", "rules.md", "questions.md", "items.md"];
	if (task.status !== "queued" || !task.queuedAt || files.some((f) => !existsSync(join(folder, f)))) return undefined;
	if (/^\s*-\s\[\s\]/m.test(text(join(folder, "questions.md")))) return undefined;
	if (JSON.stringify(task.allowedPaths) !== JSON.stringify(c.allowedPaths) || JSON.stringify(task.checks) !== JSON.stringify(c.checks)) return undefined;
	if (c.queue !== `.tasks/${c.task}/items.md`) return undefined;
	return hash([files.map((f) => text(join(folder, f))), c.allowedPaths, c.checks, c.model, c.thinking, c.queue, c.runIn, c.piCommand, c.checkBroker]);
}

export function assessHealth(state, items, { running, stopped, paused }) {
	if (stopped || paused) return "manual";
	if (Object.values(state.running ?? {}).some((r) => r.quarantined) || (!running && Object.keys(state.running ?? {}).length)) return "blocked";
	if (running) return "healthy"; // quiet checks and provider retries are not evidence of a hang
	if (!state.startedAt || ["starting", "diagnosing the failed baseline", ""].includes(state.phase)) return "blocked";
	if (items.every((i) => state.done?.[i.key])) return "complete";
	if (items.some((i) => state.failed?.[i.key])) return "failed";
	return state.phase === "running items" ? "crashed" : "blocked";
}

/** The manager proposes; this deterministic boundary grants only bounded existing-item recovery. */
export function validateProposal(proposal, state, items, manager, health) {
	if (proposal?.action === "wait") return undefined;
	if (typeof proposal?.reason !== "string" || !proposal.reason.trim()) throw new Error("manager must explain its diagnosis");
	if (proposal.action === "restart" && health === "crashed" && (manager.restarts ?? 0) < 2) return { action: "restart" };
	if (proposal.action !== "retry" || health !== "failed" || !Array.isArray(proposal.ids) || !proposal.ids.length) throw new Error("manager action is not permitted");
	const ids = [...new Set(proposal.ids)];
	for (const id of ids) {
		const item = items.find((i) => i.id === id);
		const failure = item && state.failed?.[item.key];
		if (!failure || (manager.attempts?.[id] ?? 0) >= 2) throw new Error(`${id}: not failed or recovery budget exhausted`);
		if (/BLOCKED|credentials?|missing contract|decision|outside.*(scope|allowed)|runner error/i.test(failure)) throw new Error(`${id}: needs human attention, not an automatic retry`);
	}
	return { action: "retry", ids, reason: proposal.reason.slice(0, 3000) };
}

function managerPrompt(repo, c, state, items, health, manager) {
	const folder = join(repo, ".tasks", c.task);
	const failures = items.filter((i) => state.failed?.[i.key]);
	return `You are the automatic manager of approved task ${c.task}. The questions were answered and the queue started. You have NO tools and cannot edit code, run commands, weaken checks, change models, or expand scope. Workers implement repairs; the supervisor validates your proposal.

Diagnose the supplied evidence. Healthy/complete/manual/blocked states require wait. For failed work, propose retry only when a fresh worker can fix the original item within its original scope, using your specific diagnosis. Never retry unchanged missing credentials, decisions, contracts or safety blockers. Two recovery attempts per item, and two clean runner restarts per task, are the maximum. Group related failures. Do not propose new items.

End with ONE line: CONTROL: {"action":"wait","reason":"..."}, CONTROL: {"action":"retry","ids":["A01"],"reason":"specific diagnosis and repair guidance"}, or CONTROL: {"action":"restart","reason":"..."} (only a crashed runner with no remaining workers).

Health: ${health}; phase: ${state.phase}; passed: ${Object.keys(state.done ?? {}).length}; recovery attempts: ${JSON.stringify(manager.attempts ?? {})}; restarts: ${manager.restarts ?? 0}.
Allowed paths: ${JSON.stringify(c.allowedPaths)}
Checks (must not be weakened): ${JSON.stringify(c.checks)}
Brief: ${text(join(folder, "brief.md")).slice(0, 4000)}
Rules: ${text(join(folder, "rules.md")).slice(0, 4000)}
Answers: ${text(join(folder, "questions.md")).slice(0, 4000)}
Failures (${failures.length}; first 8):
${failures.slice(0, 8).map((i) => `${i.line}\nFailure: ${state.failed[i.key]}\n${text(join(repo, DIR, "notes", `${i.id}.md`)).slice(-6000)}`).join("\n\n")}
Problem: ${text(join(repo, DIR, "problem.txt")).slice(-4000)}`;
}

export async function supervise(repo, { tickMs = HEALTH_TICK_MS, cooldownMs = REVIEW_COOLDOWN_MS } = {}) {
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
	let child, childExited = true;
	const launch = () => {
		if (stopped() || paused() || runnerAlive()) return;
		childExited = false;
		child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "runner.mjs"), repo], { cwd: repo, stdio: ["ignore", "inherit", "inherit", "ipc"] });
		child.once("exit", () => { childExited = true; });
		child.on("error", (e) => { childExited = true; log(`runner launch failed: ${e.message}`); });
	};
	const wait = () => new Promise((resolve) => {
		const done = () => { clearTimeout(timer); child?.off("exit", done); child?.off("message", done); resolve(); };
		const timer = setTimeout(done, tickMs);
		child?.once("exit", done);
		child?.once("message", done);
	});
	try {
		const c = readConfig(repo), approval = approvedTask(repo, c);
		launch();
		if (c.manager === false || !approval) { while (!childExited || runnerAlive()) await wait(); return; }
		const file = join(repo, DIR, "manager.json");
		let manager = loadJson(file, {});
		if (manager.task !== c.task) manager = { task: c.task, approval, attempts: {}, restarts: 0 };
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
		const ctx = { repo, c, web, pi: await resolvePi(c), env: process.env, manager: true, stopRequested: () => stopped() || paused(), onWorker: (identity) => {
			if (identity.sessionId) ref.id = identity.sessionId;
			manager.pid = identity.pid;
			save();
			if (web && ref.id) web.ui({ action: "set", ids: [ref.id], pinned: true }).catch(() => {});
		} };
		while (true) {
			if (readConfig(repo).manager === false || approvedTask(repo, readConfig(repo)) !== approval) { log("task/config changed; supervision stopped"); break; }
			const state = loadJson(join(repo, DIR, "state.json"), {});
			const items = allItems(text(join(repo, c.queue)), state);
			const running = runnerAlive() || !childExited;
			const health = assessHealth(state, items, { running, stopped: stopped(), paused: paused() });
			if (health === "manual") break;
			const ready = state.startedAt && !["starting", "diagnosing the failed baseline"].includes(state.phase);
			const incident = hash([health, state.failed, manager.attempts, manager.restarts]);
			const initialize = !manager.initialized && ready && health !== "blocked";
			const actionable = ready && !running && ["failed", "crashed", "blocked"].includes(health);
			if (initialize || (actionable && manager.incident !== incident && Date.now() - (manager.lastReviewAt ?? 0) >= cooldownMs)) {
				if (pidAlive(manager.pid)) { log("previous manager turn still active; intervention deferred"); break; }
				if (web && ref.id && (await web.running()).runningSessionIds?.includes(ref.id)) { log("manager session already busy; intervention deferred"); break; }
				manager.initialized = true;
				manager.incident = incident;
				manager.lastReviewAt = health === "healthy" ? 0 : Date.now();
				save();
				const prompt = managerPrompt(repo, c, state, items, health, manager);
				const result = await (web ? webTurn(ctx, repo, ref, `manager · ${c.task}`, prompt, 10) : piTurn(ctx, repo, ref.id, `manager · ${c.task}`, prompt, 10));
				manager.reply = (result.reply || result.err).slice(-12000);
				manager.pid = undefined;
				save();
				const latest = loadJson(join(repo, DIR, "state.json"), {});
				if (stopped() || paused() || readConfig(repo).manager === false || approvedTask(repo, readConfig(repo)) !== approval || latest.runId !== state.runId || JSON.stringify(latest.failed) !== JSON.stringify(state.failed)) continue;
				if (result.status !== "ok" || result.quiescent === false) { log(`review failed: ${result.err || result.status}`); if (!running) break; continue; }
				try {
					const line = result.reply.split("\n").filter((l) => l.startsWith("CONTROL:")).at(-1);
					const action = validateProposal(JSON.parse(line?.slice(8) ?? "null"), latest, items, manager, health);
					if (action) {
						if (runnerAlive() || Object.keys(latest.running ?? {}).length) throw new Error("runner/worker ownership changed");
						if (action.action === "retry") {
							const failures = {};
							mkdirSync(join(repo, DIR, "notes"), { recursive: true });
							for (const id of action.ids) {
								manager.attempts[id] = (manager.attempts[id] ?? 0) + 1;
								const item = items.find((i) => i.id === id);
								failures[id] = latest.failed[item.key];
								appendFileSync(join(repo, DIR, "notes", `${id}.md`), `\n\n## Manager diagnosis\n${action.reason}\n`);
							}
							save(); // persist the budget before dispatch
							enqueueControl(repo, { task: c.task, by: "auto", action: "retry", ids: action.ids, failures });
						} else { manager.restarts++; save(); }
						log(`${action.action} ${action.ids?.join(", ") ?? "runner"}`);
						launch();
						await wait();
						continue;
					}
				} catch (e) { log(`proposal not applied: ${e.message}`); }
			}
			if (!running && (health === "complete" || manager.incident === incident || !ready)) break;
			await wait();
		}
	} finally {
		// Keep ownership until the child drains, including manual pause/stop and startup failures.
		while (!childExited) await wait();
		for (const sig of signals) process.off(sig, onSignal);
		process.off("exit", release);
		release();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) supervise(process.argv[2] || process.cwd()).catch((e) => { console.error(e); process.exitCode = 1; });
