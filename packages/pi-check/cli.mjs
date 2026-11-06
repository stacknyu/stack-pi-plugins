#!/usr/bin/env node
// pi-check command line. Agents normally use the `check` tool; this is for people, scripts, the pi-flow
// runner, and the `go` shim.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, SHIM_DIR, call, cleanPath, connect, installShims } from "./lib/client.mjs";
import { CONFIG_FILE } from "./lib/repo.mjs";
import { STATE_DIR, VERSION, fmtMs, normRel, repoRoots, shq, tailLines, which } from "./lib/util.mjs";

const HELP = `pi-check ${VERSION} — one shared, cached, speculative check runner per repo (Go, TypeScript, Python)

  pi-check run [changed|all] [options]   run checks; prints a report, exit 1 on new failures
      --files a,b        only units that depend on these files
      --kind test,lint   test | typecheck | lint | vet | custom
      --lang go,ts       go | ts | python | custom
      --project dir      only this project (repeatable)
      --base ref         compare with this branch (default: the branch the main checkout is on)
      --strict           pre-existing (base) failures fail too
      --refresh          ignore cached results
      --json             machine-readable report
  pi-check exec [--cwd dir] -- <command>  run a raw command through the broker (shared + cached + throttled)
  pi-check status [--json]                what runs, what waits, cache savings
  pi-check projects                       detected projects and checks
  pi-check baseline                       run everything on the main checkout; failures there become "known"
  pi-check known [list|add ID…|remove ID|PATTERN…|clear]
  pi-check speculate [--all]              pre-run what the current changes affect (--all: everything)
  pi-check cancel                         drop queued/speculative work for this checkout
  pi-check init                           write ${CONFIG_FILE} with the detected setup
  pi-check log [-n 80]                    broker log
  pi-check reload                         apply config after requested work drains
  pi-check start | stop | restart | forget (clear the cache) | install-shims
`;

function parse(argv) {
	const o = { _: [], project: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			o.rest = argv.slice(i + 1);
			break;
		}
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split("=");
			const bool = ["strict", "refresh", "json", "all", "quiet", "help"].includes(k);
			const val = bool ? true : (v ?? argv[++i]);
			if (k === "project") o.project.push(val);
			else o[k] = val;
		} else if (a === "-n") o.n = Number(argv[++i]);
		else o._.push(a);
	}
	return o;
}

const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const err = (s) => process.stderr.write(`${s}\n`);

async function main() {
	const argv = process.argv.slice(2);
	const cmd = argv[0];
	if (cmd === "shim") return shim(argv.slice(1));
	const o = parse(argv.slice(1));
	const cwd = resolve(o.cwd ?? process.cwd());
	switch (cmd) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(HELP);
			return 0;
		case "run": {
			const scope = o._[0] === "all" ? "all" : o.files ? "files" : "changed";
			const r = await call(cwd, "/run", { scope, files: list(o.files)?.map((f) => toRepoRel(cwd, f)), kinds: list(o.kind), langs: list(o.lang), projects: o.project.length ? o.project : undefined, base: o.base, strict: o.strict, refresh: o.refresh, priority: o.priority ? Number(o.priority) : undefined, label: o.label ?? "cli" }, o.json || o.quiet ? undefined : progress);
			if (o.json) process.stdout.write(`${JSON.stringify(r.report, null, 2)}\n`);
			else process.stdout.write(`${r.report.text}\n`);
			return r.report.ok ? 0 : 1;
		}
		case "exec": {
			const command = (o.rest ?? o._).join(" ");
			if (!command) return err("usage: pi-check exec [--cwd dir] -- <command>"), 2;
			return execCommand(cwd, command);
		}
		case "status": {
			const c = await connect(cwd, { start: false });
			if (!c.info) {
				process.stdout.write("pi-check broker is not running in this repo (it starts on the first check).\n");
				return 0;
			}
			const s = await call(cwd, "/status");
			if (o.json) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
			else process.stdout.write(`${statusText(s)}\n`);
			return 0;
		}
		case "projects": {
			const r = await call(cwd, "/projects", {});
			for (const p of r.projects) process.stdout.write(`${p.lang.padEnd(7)} ${p.dir.padEnd(32)} ${Object.entries(p.units).map(([k, n]) => `${k}:${n}`).join("  ")}${p.meta?.tester ? `  [${p.meta.tester}]` : ""}${p.meta?.linter ? `  [${p.meta.linter}]` : ""}\n`);
			if (!r.projects.length) process.stdout.write("No Go modules, TypeScript/JavaScript packages or Python projects with checks found.\n");
			return 0;
		}
		case "baseline": {
			const rr = repoRoots(cwd);
			const r = await call(rr.main, "/run", { scope: "all", priority: 5, label: "baseline" }, progress);
			const k = await call(rr.main, "/known", {});
			process.stdout.write(`${r.report.text}\n\nKnown failures recorded from the main checkout: ${Object.keys(k.known).length}\n`);
			return 0;
		}
		case "known": {
			const sub = o._[0] ?? "list";
			const ids = o._.slice(1);
			const body = sub === "add" ? { action: "add", ids } : sub === "remove" ? { action: "remove", ids, pattern: ids.length === 1 ? ids[0] : undefined } : sub === "clear" ? { action: "clear" } : {};
			const r = await call(cwd, "/known", body);
			const entries = Object.entries(r.known);
			if (o.json) process.stdout.write(`${JSON.stringify(r.known, null, 2)}\n`);
			else {
				for (const [id, k] of entries) process.stdout.write(`${k.source === "manual" ? "[manual] " : ""}${k.title ?? id}\n`);
				process.stdout.write(`${entries.length} known failure${entries.length === 1 ? "" : "s"}\n`);
			}
			return 0;
		}
		case "speculate": {
			const r = await call(cwd, "/speculate", { all: !!o.all });
			process.stdout.write(`queued ${r.queued} unit${r.queued === 1 ? "" : "s"} at low priority\n`);
			return 0;
		}
		case "cancel": {
			const rr = repoRoots(cwd);
			const r = await call(cwd, "/cancel", { root: o.all ? undefined : rr.root });
			process.stdout.write(`cancelled ${r.cancelled}\n`);
			return 0;
		}
		case "reload": {
			const r = await call(cwd, "/reload", {});
			process.stdout.write(r.deferred ? "configuration queued; applies after requested checks finish\n" : "configuration applied\n");
			return 0;
		}
		case "start":
			await connect(cwd);
			process.stdout.write("pi-check broker running\n");
			return 0;
		case "stop":
		case "restart": {
			const c = await connect(cwd, { start: false });
			if (c.info) {
				try {
					await call(cwd, "/stop", {}, undefined, { start: false, timeoutMs: 3000 });
				} catch {}
				await new Promise((r) => setTimeout(r, 600));
			}
			if (cmd === "restart") await connect(cwd);
			process.stdout.write(cmd === "restart" ? "pi-check broker restarted\n" : "pi-check broker stopped\n");
			return 0;
		}
		case "forget":
			await call(cwd, "/forget", {});
			process.stdout.write("cache cleared\n");
			return 0;
		case "log": {
			const rr = repoRoots(cwd);
			const p = join(rr.main, STATE_DIR, "broker.log");
			process.stdout.write(`${existsSync(p) ? tailLines(readFileSync(p, "utf8"), o.n || 80) : "(no log yet)"}\n`);
			return 0;
		}
		case "init": {
			const rr = repoRoots(cwd);
			const p = join(rr.main, CONFIG_FILE);
			if (existsSync(p)) {
				process.stdout.write(`${CONFIG_FILE} already exists — edit it, then: pi-check reload\n`);
				return 0;
			}
			const r = await call(cwd, "/projects", {});
			const projects = {};
			for (const pr of r.projects) projects[pr.dir] = Object.fromEntries(pr.kinds.map((k) => [k, k === "test" ? { timeout: pr.lang === "go" ? "10m" : "15m", env: {} } : {}]));
			writeFileSync(p, `${JSON.stringify({ $comment: "pi-check settings, shared with the team. Per project: <kind>: false disables it; inputs: extra globs (project-relative) that tests read at runtime; env/args/timeout/parallel per kind.", maxJobs: 0, cpuBudget: 0, threads: 0, speculate: true, warmBase: false, intercept: "route", ignore: [], projects, custom: [] }, null, 2)}\n`);
			await call(cwd, "/reload", {});
			process.stdout.write(`wrote ${p}\n`);
			return 0;
		}
		case "install-shims":
			process.stdout.write(`${installShims()}\n`);
			return 0;
		default:
			process.stdout.write(HELP);
			return 2;
	}
}

function toRepoRel(cwd, f) {
	const rr = repoRoots(cwd);
	const abs = resolve(cwd, f);
	return abs.startsWith(`${rr.root}/`) ? normRel(abs.slice(rr.root.length + 1)) : normRel(f);
}

let lastProgress = 0;
function progress(ev) {
	if (ev.type === "start") err(`pi-check: ${ev.units} units — ${ev.cached} cached, ${ev.joined} already running elsewhere, ${ev.queued} to run`);
	else if (ev.type === "progress" && Date.now() - lastProgress > 15000) {
		lastProgress = Date.now();
		err(`pi-check: ${ev.done ?? "…"}/${ev.total ?? "…"} done · ${ev.text ?? ""}`);
	}
}

function statusText(s) {
	const st = s.stats;
	const lines = [
		`pi-check ${s.version} · pid ${s.pid} · up ${s.uptime} · ${s.cpus} cores, load ${s.load} · ${s.maxJobs} job slots, ${s.allocatedCpus ?? "?"}/${s.cpuBudget ?? s.cpus} CPU budget allocated${s.configPending ? " · config waiting for idle" : ""} · speculation ${s.speculate ? "on" : "off"}`,
		`running (${s.running.length}): ${s.running.map((j) => `${j.root}: ${j.label}${j.speculative ? " [speculative]" : ""} ${j.for}`).join(" | ") || "nothing"}`,
		`queued: ${s.pending.requested} requested, ${s.pending.speculative} speculative`,
		`checkouts: ${s.roots.map((r) => `${r.name}${r.watching ? " (watching)" : ""}`).join(", ")}`,
		`units asked ${st.unitsAsked}: ${st.cacheHits} cached, ${st.joined} joined a run in progress, ${st.ran} ran (+${st.speculativeRan} speculative, ${st.speculativeUsed} of those used) · exec ${st.execRuns} ran / ${st.execHits} reused`,
		`reused unit-runtime ≈ ${st.saved} (not wall-time savings) · execution time ${st.spent} · preempted ${st.preempted}`,
		`known (pre-existing) failures: ${s.known}`,
	];
	if (s.recent?.length) lines.push("recent:", ...s.recent.slice(0, 6).map((r) => `  ${new Date(r.at).toLocaleTimeString()} ${r.root} ${r.scope} ${r.units}u ${r.ok ? "PASS" : `FAIL(${r.newFailures})`} ${fmtMs(r.ms)} ${r.label}`));
	return lines.join("\n");
}

async function execCommand(cwd, command, env) {
	if (process.env.PI_CHECK_BYPASS === "1") {
		const r = spawnSync("/bin/sh", ["-c", command], { cwd, stdio: "inherit", env: { ...process.env, PATH: cleanPath() } });
		return r.status ?? 1;
	}
	try {
		const r = await call(cwd, "/exec", { cwd, cmd: command, env }, (ev) => ev.type === "progress" && progress(ev));
		process.stdout.write(r.output ?? "");
		if (r.output && !r.output.endsWith("\n")) process.stdout.write("\n");
		if (r.source !== "ran") process.stdout.write(Date.now() - r.at < 3000 ? `[pi-check] the same command on identical files was already running${r.source === "shared" ? ` in ${r.root}` : ""} — waited for it and reused its result\n` : `[pi-check] same command on identical files already ran${r.source === "shared" ? ` in ${r.root}` : ""} ${fmtMs(Date.now() - r.at)} ago — result reused, not rerun\n`);
		if (r.stale) process.stdout.write("[pi-check] files changed while this ran; the result may not match the current files\n");
		return r.stale ? 1 : r.code ?? 1;
	} catch (e) {
		err(`[pi-check] broker unavailable (${e.message}); inspect status before retrying. No unbudgeted duplicate was started.`);
		return 2;
	}
}

// ---------- go shim ----------

const GO_VALUE_FLAGS = new Set(["run", "skip", "timeout", "count", "p", "parallel", "tags", "shuffle", "cpu", "vet", "coverpkg", "covermode", "ldflags", "gcflags", "mod", "modfile", "C", "exec", "o", "outputdir", "coverprofile", "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "bench", "benchtime", "fuzz", "fuzztime", "list"]);
const GO_PASSTHROUGH = new Set(["bench", "benchtime", "benchmem", "c", "o", "exec", "coverprofile", "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "fuzz", "fuzztime", "list", "args", "json", "outputdir", "i", "n", "x", "work", "C", "modfile", "toolexec", "test.v"]);

export function parseGoArgs(a) {
	const flags = [];
	const pkgs = [];
	let verbose = false;
	let pass = false;
	let refresh = false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		if (x.startsWith("-") && x !== "-") {
			const body = x.replace(/^--?/, "");
			const [name, inline] = body.split(/=(.*)/s);
			if (GO_PASSTHROUGH.has(name) || name.startsWith("test.")) pass = true;
			let val = inline;
			const takesValue = GO_VALUE_FLAGS.has(name) && inline === undefined;
			if (takesValue) val = a[++i];
			if (name === "v") {
				verbose = val !== "false";
				continue;
			}
			if (name === "p") continue; // the broker owns build concurrency
			if (name === "count") refresh = true;
			const f = val === undefined ? `-${name}` : `-${name}=${val}`;
			flags.push(f);

		} else {
			if (x.endsWith(".go")) pass = true;
			pkgs.push(x);
		}
	}
	return { flags, pkgs, verbose, pass, refresh };
}

async function shim(args) {
	const tool = args[0], rest = args.slice(1);
	const real = which(tool, { skipDir: process.env.PI_CHECK_SHIM_DIR || SHIM_DIR }) ?? tool;
	const passthrough = () => {
		const r = spawnSync(real, rest, { stdio: "inherit", env: { ...process.env, PATH: cleanPath() } });
		process.exit(r.status ?? 1);
	};
	if (tool !== "go" || process.env.PI_CHECK_BYPASS === "1" || !["test", "vet"].includes(rest[0])) return passthrough();
	const sub = rest[0];
	const { flags, pkgs, verbose, pass, refresh } = parseGoArgs(rest.slice(1));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GO[A-Z0-9_]*|CGO_[A-Z0-9_]+|CC|CXX|PKG_CONFIG)$/.test(k)).sort());
	env.PATH = cleanPath();
	const cwd = process.cwd();
	const rr = repoRoots(cwd);
	if (!rr) return passthrough();
	const viaExec = async () => process.exit(await execCommand(cwd, ["go", ...rest].map((s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shq(s))).join(" "), env));
	if (pass) return viaExec();
	const cwdRel = cwd === rr.root ? "." : normRel(cwd.slice(rr.root.length + 1));
	let r;
	try {
		r = await call(cwd, "/run", { goSelect: { cwdRel, patterns: pkgs }, kinds: [sub], extraArgs: flags, extraKey: JSON.stringify(flags), env, refresh, detail: true, label: `go ${sub} (agent)` }, (ev) => ev.type === "progress" && progress(ev));
	} catch (e) {
		err(`[pi-check] broker unavailable (${e.message}); inspect status before retrying. No unbudgeted duplicate was started.`);
		process.exit(2);
	}
	const rep = r.report;
	if (rep.go?.unsupported) return viaExec();
	const byLabel = new Map((rep.results ?? []).map((x) => [x.label, x]));
	let anyNew = !rep.ok;
	const knownLines = [];
	for (const ip of rep.go?.order ?? []) {
		const x = byLabel.get(ip);
		if (!x) {
			if (sub === "test") process.stdout.write(`?   \t${ip}\t[no test files]\n`);
			continue;
		}
		const tag = x.source === "ran" ? "" : `\t(pi-check: ${x.source === "shared" ? `shared from ${x.root}` : "cached"})`;
		if (sub === "vet") {
			if (x.status !== "pass") {
				const known = new Set(x.known ?? []);
				process.stderr.write(`# ${ip}\n${(x.failures ?? []).map((f) => `${f.title}${known.has(f.id) ? "  [pre-existing on base]" : ""}`).join("\n")}\n`);
				if ((x.failures ?? []).some((f) => !known.has(f.id))) anyNew = true;
			}
			continue;
		}
		if (verbose && x.output) {
			process.stdout.write(x.output.endsWith("\n") ? x.output : `${x.output}\n`);
			if (tag) process.stdout.write(`${tag.trim()}\n`);
			if (x.status === "pass") continue;
		}
		if (x.status === "pass") {
			process.stdout.write(`ok  \t${ip}\t${(x.seconds ?? x.ms / 1000 ?? 0).toFixed(3)}s${tag}\n`);
			continue;
		}
		const known = new Set(x.known ?? []);
		for (const f of x.failures ?? []) {
			if (!verbose) process.stdout.write(f.output ? (f.output.endsWith("\n") ? f.output : `${f.output}\n`) : `--- FAIL: ${f.title}\n`);
			if (known.has(f.id)) knownLines.push(f.title);
			else anyNew = true;
		}
		if (!verbose) process.stdout.write(`FAIL\t${ip}\t${(x.seconds ?? 0).toFixed(3)}s${tag}\n`);
	}
	if (knownLines.length) process.stdout.write(`[pi-check] ${knownLines.length} failure${knownLines.length > 1 ? "s" : ""} above also fail on the base branch (pre-existing, not caused by these changes):\n${knownLines.map((l) => `  - ${l}`).join("\n")}\n`);
	if (anyNew) process.stdout.write("FAIL\n");
	process.exit(anyNew ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().then(
	(code) => process.exit(code ?? 0),
	(e) => {
		err(`pi-check: ${e?.message ?? e}`);
		process.exit(2);
	},
);

export { CLI };
