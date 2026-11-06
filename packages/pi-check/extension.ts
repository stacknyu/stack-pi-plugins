/**
 * pi-check — one shared check runner per repo for every Pi session and worktree.
 *
 *   check tool        agents run tests / typecheck / lint for what their changes affect; results are
 *                     shared across sessions, cached by file content, and pre-existing failures are separated
 *   bash routing      raw `go test`, `pytest`, `vitest`, `tsc`, `eslint`… commands go through the broker too
 *   /check            status | run [all] | baseline | known | speculate | cancel | stop | restart | init | log
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLI, SHIM_DIR, call, connect, installShims } from "./lib/client.mjs";
import { CONFIG_FILE, loadConfig } from "./lib/repo.mjs";
import { STATE_DIR, repoRoots, shq, tailLines } from "./lib/util.mjs";
import { isCheckCommand, isGoCommand } from "./lib/commands.mjs";

const rootsMemo = new Map<string, any>();
function roots(cwd: string): any {
	if (!rootsMemo.has(cwd)) rootsMemo.set(cwd, repoRoots(cwd) ?? null);
	return rootsMemo.get(cwd);
}

function config(cwd: string): any {
	const r = roots(cwd);
	return r ? loadConfig(r.main) : undefined;
}

function statusLine(s: any): string | undefined {
	if (!s) return undefined;
	const run = s.running?.filter((j: any) => !j.speculative).length ?? 0;
	const spec = s.running?.filter((j: any) => j.speculative).length ?? 0;
	const q = s.pending?.requested ?? 0;
	if (!run && !spec && !q) return s.stats?.savedMs > 60000 ? `checks idle · reused ${s.stats.saved} unit-runtime` : undefined;
	return `checks: ${run} running${spec ? ` +${spec} ahead-of-time` : ""}${q ? ` · ${q} queued` : ""}`;
}

export default function (pi: ExtensionAPI) {
	let shimsReady = false;
	try {
		installShims();
		shimsReady = true;
	} catch {}

	let timer: any;
	const watchStatus = (ctx: any) => {
		clearInterval(timer);
		if (!ctx?.hasUI && !ctx?.ui) return;
		timer = setInterval(async () => {
			try {
				const r = roots(ctx.cwd);
				if (!r || !existsSync(join(r.main, STATE_DIR, "broker.json"))) return ctx.ui?.setStatus?.("check", undefined);
				const c = await connect(ctx.cwd, { start: false });
				if (!c.info) return ctx.ui?.setStatus?.("check", undefined);
				const s = await call(ctx.cwd, "/status", undefined, undefined, { start: false, timeoutMs: 2000 });
				ctx.ui?.setStatus?.("check", statusLine(s));
			} catch {}
		}, 4000);
		timer.unref?.();
	};

	pi.on("session_start", async (_e: any, ctx: any) => {
		const r = roots(ctx.cwd);
		if (!r) return;
		// repos that use pi-check: make sure this checkout is watched, so checks run ahead of time
		if (existsSync(join(r.main, CONFIG_FILE)) || existsSync(join(r.main, STATE_DIR))) {
			call(ctx.cwd, "/touch", {}).catch(() => {});
			watchStatus(ctx);
		}
	});
	pi.on("session_shutdown", async () => clearInterval(timer));

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "bash" || typeof event.input?.command !== "string") return;
		const command: string = event.input.command;
		if (command.includes("pi-check") || command.includes("PI_CHECK_BYPASS")) return;
		const r = roots(ctx.cwd);
		if (!r) return;
		const cfg = config(ctx.cwd);
		if (!cfg || cfg.intercept === "off") return;
		if (isCheckCommand(command)) {
			if (cfg.intercept === "block")
				return { block: true, reason: "Run checks with the `check` tool instead (it runs only what your changes affect and shares results with other sessions). For a specific command: pi-check exec -- <command>." };
			event.input.command = `${shq(process.execPath)} ${shq(CLI)} exec --cwd ${shq(ctx.cwd)} -- ${shq(command)}`;
			return;
		}
		if (shimsReady && cfg.shimGo && isGoCommand(command)) event.input.command = `export PATH=${shq(SHIM_DIR)}:"$PATH"; ${command}`;
	});

	pi.registerTool({
		name: "check",
		label: "Check",
		description:
			"Run the repo's tests, type checks and linters (Go, TypeScript/JavaScript, Python) through the shared check broker. By default only what your changes affect (vs the base branch) runs: packages/test files/projects whose inputs changed. Results are cached by file content and shared with every other session and worktree, identical runs in progress are joined instead of repeated, and failures that also fail on the base branch are reported as pre-existing (they do not fail the check).",
		promptSnippet: "check: run affected tests/typecheck/lint via the shared, cached check broker",
		promptGuidelines: [
			"Use the `check` tool to run tests, type checks and linters instead of running go test, pytest, vitest, jest, tsc, eslint or ruff in bash: it runs only what your changes affect, reuses results other sessions already have, and separates pre-existing failures from ones you caused.",
			"Call `check` after a meaningful set of edits, not after every small edit; it also runs affected checks in the background while you work, so results are often ready.",
			"Fix failures marked new; failures marked pre-existing also fail on the base branch — leave them unless your task is to fix them.",
		],
		parameters: Type.Object({
			scope: Type.Optional(Type.Union([Type.Literal("changed"), Type.Literal("all")], { description: "changed (default): what your changes affect. all: everything." })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Only checks that depend on these files (repo- or cwd-relative)" })),
			kinds: Type.Optional(Type.Array(Type.Union(["test", "typecheck", "lint", "vet", "custom"].map((k) => Type.Literal(k))))),
			projects: Type.Optional(Type.Array(Type.String({ description: "Project dirs, e.g. apps/dashboard" }))),
			strict: Type.Optional(Type.Boolean({ description: "Count pre-existing failures too" })),
			refresh: Type.Optional(Type.Boolean({ description: "Ignore cached results and run again" })),
		}),
		async execute(_id: string, p: any, _signal: any, onUpdate: any, ctx: any) {
			if (!roots(ctx.cwd)) return { content: [{ type: "text", text: "check: not inside a git repository." }], details: {} };
			const scope = p.files?.length ? "files" : p.scope === "all" ? "all" : "changed";
			const r = roots(ctx.cwd);
			const files = (p.files ?? []).map((f: string) => {
				const abs = f.startsWith("/") ? f : join(ctx.cwd, f);
				return abs.startsWith(`${r.root}/`) ? abs.slice(r.root.length + 1) : f;
			});
			let lastText = "";
			try {
				const res: any = await call(ctx.cwd, "/run", { scope, files, kinds: p.kinds, projects: p.projects, strict: p.strict, refresh: p.refresh, label: "check tool" }, (ev: any) => {
					const t = ev.type === "start" ? `checking ${ev.units} units: ${ev.cached} cached, ${ev.joined} already running elsewhere, ${ev.queued} to run` : ev.type === "progress" ? `${ev.done ?? ""}/${ev.total ?? ""} · ${ev.text ?? ""}` : "";
					if (t && t !== lastText) {
						lastText = t;
						onUpdate?.({ content: [{ type: "text", text: t }], details: {} });
					}
				}, { signal: _signal });
				const rep = res.report;
				return { content: [{ type: "text", text: rep.text }], details: { ok: rep.ok, newFailures: rep.newFailures, knownFailures: rep.knownFailures, units: rep.units, ran: rep.ran, cached: rep.cache, shared: rep.shared }, isError: !rep.ok };
			} catch (e: any) {
				if (_signal?.aborted) return { content: [{ type: "text", text: "check: cancelled this request; other sessions' checks were not cancelled." }], details: {}, isError: true };
				return { content: [{ type: "text", text: `check: the check broker failed: ${e?.message ?? e}. Inspect /check status before retrying; do not start an unbudgeted duplicate.` }], details: {}, isError: true };
			}
		},
	} as any);

	pi.registerCommand("check", {
		description: "Shared check broker: /check [status] | run [all] | baseline | known [clear] | speculate [all] | cancel | reload | stop | restart | init | log",
		handler: async (args: string, ctx: any) => {
			const [cmd = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cwd = ctx.cwd;
			const r = roots(cwd);
			if (!r) return ctx.ui.notify("check: not inside a git repository.", "warning");
			try {
				if (cmd === "status") {
					const c = await connect(cwd, { start: false });
					if (!c.info) return ctx.ui.notify("check: the broker is not running here; it starts with the first check (/check run).", "info");
					const s: any = await call(cwd, "/status");
					const st = s.stats;
					ctx.ui.notify(
						[
							`pi-check · ${s.cpus} cores, load ${s.load} · ${s.maxJobs} job slots, ${s.allocatedCpus ?? "?"}/${s.cpuBudget ?? s.cpus} CPU budget allocated${s.configPending ? " · config waiting for idle" : ""} · ahead-of-time runs ${s.speculate ? "on" : "off"}`,
							`running: ${s.running.map((j: any) => `${j.root}: ${j.label}${j.speculative ? " (ahead of time)" : ""} ${j.for}${j.activity ? ` · ${j.activity}` : ""}`).join(" | ") || "nothing"}`,
							`queued: ${s.pending.requested} requested, ${s.pending.speculative} ahead-of-time`,
							`checkouts watched: ${s.roots.map((x: any) => x.name).join(", ")}`,
							`asked ${st.unitsAsked} units: ${st.cacheHits} cached, ${st.joined} joined a run in progress, ${st.ran} ran · ${st.speculativeRan} ran ahead of time · reused unit-runtime ≈ ${st.saved} (not wall-time savings)`,
							`pre-existing failures known: ${s.known}`,
						].join("\n"),
						"info",
					);
					watchStatus(ctx);
					return;
				}
				if (cmd === "run" || cmd === "baseline") {
					const base = cmd === "baseline";
					ctx.ui.notify(base ? "check: running everything on the main checkout…" : "check: running…", "info");
					const res: any = await call(base ? r.main : cwd, "/run", { scope: base || rest[0] === "all" ? "all" : "changed", label: base ? "baseline" : "/check" });
					ctx.ui.notify(tailLines(res.report.text, 60), res.report.ok ? "info" : "warning");
					watchStatus(ctx);
					return;
				}
				if (cmd === "known") {
					const res: any = await call(cwd, "/known", rest[0] === "clear" ? { action: "clear" } : rest[0] === "remove" ? { action: "remove", pattern: rest[1] } : {});
					const e = Object.entries(res.known);
					ctx.ui.notify(`${e.map(([id, k]: any) => `${k.source === "manual" ? "[manual] " : ""}${k.title ?? id}`).join("\n") || "(none)"}\n${e.length} known failure(s)`, "info");
					return;
				}
				if (cmd === "speculate") {
					const res: any = await call(cwd, "/speculate", { all: rest[0] === "all" });
					ctx.ui.notify(`check: ${res.queued} unit(s) queued to run ahead of time.`, "info");
					return;
				}
				if (cmd === "cancel") {
					const res: any = await call(cwd, "/cancel", { root: r.root });
					ctx.ui.notify(`check: cancelled ${res.cancelled}.`, "info");
					return;
				}
				if (cmd === "reload") {
					const res: any = await call(cwd, "/reload", {});
					ctx.ui.notify(res.deferred ? "check: configuration queued; applies after requested work finishes." : "check: configuration applied.", "info");
					return;
				}
				if (cmd === "stop" || cmd === "restart") {
					const c = await connect(cwd, { start: false });
					if (c.info) await call(cwd, "/stop", {}, undefined, { start: false, timeoutMs: 3000 }).catch(() => {});
					if (cmd === "restart") {
						await new Promise((res) => setTimeout(res, 700));
						await connect(cwd);
					}
					ctx.ui.notify(`check: broker ${cmd === "stop" ? "stopped" : "restarted"}.`, "info");
					return;
				}
				if (cmd === "init" || cmd === "log" || cmd === "projects") {
					const { spawnSync } = await import("node:child_process");
					const out = spawnSync(process.execPath, [CLI, cmd], { cwd, encoding: "utf8" });
					ctx.ui.notify(`${out.stdout}${out.stderr}`.trim() || "(no output)", "info");
					return;
				}
				ctx.ui.notify("Usage: /check [status] | run [all] | baseline | known [clear|remove <text>] | speculate [all] | cancel | reload | stop | restart | init | projects | log", "warning");
			} catch (e: any) {
				ctx.ui.notify(`check: ${e?.message ?? e}`, "error");
			}
		},
	});
}

export { statusLine };
