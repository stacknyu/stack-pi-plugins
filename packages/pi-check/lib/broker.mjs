#!/usr/bin/env node
// pi-check broker: one per repo, shared by the main checkout and every worktree.
// Units of work (a Go package's tests, a test file, a project's typecheck, a file's lint) are keyed by
// the content of everything they depend on. Same content => same key => run once, shared by everyone.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import { loadavg } from "node:os";
import { join } from "node:path";
import custom from "./adapters/custom.mjs";
import go, { goGraph } from "./adapters/go.mjs";
import python from "./adapters/python.mjs";
import ts from "./adapters/ts.mjs";
import { RootCtx, kindOptions, loadConfig, rootLockfiles } from "./repo.mjs";
import { adoptLoginPath, cleanEnv, CPUS, FileHasher, STATE_DIR, VERSION, baseOf, dirOf, ensureDir, fmtMs, git, headLines, isUnder, loadJson, logTo, normRel, parseDuration, pidAlive, repoRoots, runProc, sha, tailLines, writeJson } from "./util.mjs";

export const ADAPTERS = { go, ts, python, custom };
const IGNORE_EVENT = /(^|\/)(\.git|node_modules|\.pi-queue|\.pi-check|\.pi-flow|dist|build|coverage|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|target|\.tox)(\/|$)|\.tsbuildinfo$|~$|\.swp$/;
const PRIO = { speculative: 0, warm: 0, normal: 10, gate: 20 };

let jobSeq = 0;

export class Broker {
	constructor(main) {
		this.main = main;
		this.dir = ensureDir(join(main, STATE_DIR));
		this.cacheDir = ensureDir(join(this.dir, "cache"));
		this.tmpDir = ensureDir(join(this.dir, "tmp"));
		this.config = loadConfig(main);
		this.hasher = new FileHasher();
		this.roots = new Map();
		this.inflight = new Map();
		this.pending = [];
		this.running = new Set();
		this.mem = new Map();
		this.known = loadJson(join(this.dir, "known.json"), { ids: {} }) ?? { ids: {} };
		this.known.ids ??= {};
		const st = loadJson(join(this.dir, "state.json"), {}) ?? {};
		this.stats = { requests: 0, unitsAsked: 0, cacheHits: 0, joined: 0, ran: 0, speculativeRan: 0, speculativeUsed: 0, savedMs: 0, ranMs: 0, preempted: 0, execRuns: 0, execHits: 0, ...(st.stats ?? {}) };
		this.recent = st.recent ?? [];
		this.log = logTo(join(this.dir, "broker.log"));
		this.lastUse = Date.now();
		this.unstable = new Map();
		this.dirty = false;
		this.startedAt = Date.now();
	}

	// ---------- roots ----------

	root(abs) {
		let r = this.roots.get(abs);
		if (r) {
			r.lastUse = Date.now();
			return r;
		}
		const rr = repoRoots(abs);
		if (!rr || rr.main !== this.main) throw new Error(`${abs} is not a checkout of ${this.main}`);
		const rc = new RootCtx(rr.root, this.main, this.hasher, this.config);
		r = { rc, abs: rr.root, name: rr.root === this.main ? "main" : baseOf(rr.root), watchers: [], changes: new Set(), timer: undefined, lastUse: Date.now(), watching: false };
		this.roots.set(rr.root, r);
		if (rr.root !== abs) this.roots.set(abs, r);
		if (this.config.watch) this.watchRoot(r);
		return r;
	}

	watchRoot(r) {
		this.unwatch(r);
		const onEvent = (base) => (ev, name) => {
			if (!name) return;
			const relPath = normRel(base === "." ? String(name) : `${base}/${name}`);
			if (IGNORE_EVENT.test(relPath)) return;
			r.changes.add(relPath);
			if (ev === "rename") r.structural = true;
			// a speculative run whose inputs just changed is wasted work: stop it
			for (const job of this.running) if (job.root === r && job.speculativeOnly() && job.inputSet.has(relPath)) this.abortJob(job, "inputs changed");
			clearTimeout(r.timer);
			r.timer = setTimeout(() => this.settle(r), this.config.debounceMs);
		};
		try {
			if (process.platform === "linux") {
				// recursive watching on Linux walks node_modules too; watch only directories git sees
				const dirs = new Set(["."]);
				for (const f of r.rc.listing().files) {
					let d = dirOf(f);
					while (d !== "." && !dirs.has(d)) {
						dirs.add(d);
						d = dirOf(d);
					}
				}
				for (const d of dirs) {
					try {
						const w = watch(r.rc.path(d), { persistent: false }, onEvent(d));
						w.on("error", () => {});
						r.watchers.push(w);
					} catch {}
				}
				r.watchedDirs = dirs;
			} else {
				const w = watch(r.abs, { recursive: true, persistent: false }, onEvent("."));
				w.on("error", () => {});
				r.watchers.push(w);
			}
			r.watching = true;
		} catch (e) {
			this.log("watch failed", r.abs, String(e?.message ?? e));
			r.watching = false;
		}
	}

	unwatch(r) {
		for (const w of r.watchers) {
			try {
				w.close();
			} catch {}
		}
		r.watchers = [];
		r.watching = false;
	}

	settle(r) {
		if (!existsSync(r.abs)) return this.dropRoot(r);
		const before = r.rc.listing().set;
		r.rc.invalidate(true);
		const after = r.rc.listing().set;
		const changed = new Set([...r.changes].filter((f) => after.has(f) || before.has(f)));
		r.changes.clear();
		if (r.structural && process.platform === "linux") {
			const newDirs = [...after].map(dirOf).filter((d) => !r.watchedDirs?.has(d));
			if (newDirs.length) this.watchRoot(r);
		}
		r.structural = false;
		if (!changed.size) return;
		this.log("changed", r.name, changed.size, [...changed].slice(0, 5));
		if (this.config.speculate) this.speculate(r, changed);
	}

	dropRoot(r) {
		this.unwatch(r);
		for (const [k, v] of this.roots) if (v === r) this.roots.delete(k);
		for (const t of this.pending.filter((x) => x.root === r)) this.resolveTask(t, { status: "error", failures: [{ id: `${t.uid}:[gone]`, title: "checkout was removed", output: "" }] });
		this.pending = this.pending.filter((t) => t.root !== r);
		this.log("root removed", r.abs);
	}

	/** Re-read structure unless the watcher says nothing changed recently. Hashes are always re-checked. */
	refreshRoot(r) {
		const l = r.rc._listing;
		if (r.watching && !r.changes.size && l && Date.now() - l.at < 30000) return;
		r.rc.invalidate(true);
	}

	// ---------- planning ----------

	projects(rc) {
		let p = rc.memo.get("projects");
		if (p) return p;
		p = [];
		for (const a of Object.values(ADAPTERS)) {
			try {
				p.push(...a.detect(rc));
			} catch (e) {
				this.log("detect failed", a.lang, String(e?.stack ?? e));
			}
		}
		rc.memo.set("projects", p);
		return p;
	}

	unitsOf(rc, project, kind, env, extraArgs) {
		const k = `units:${project.id}|${kind}|${JSON.stringify([env, extraArgs])}`;
		let u = rc.memo.get(k);
		if (!u) {
			u = ADAPTERS[project.lang].units(rc, project, kind, { env, extraArgs });
			rc.memo.set(k, u);
		}
		return u;
	}

	keyOf(rc, project, kind, unit, extra = "", env) {
		const a = ADAPTERS[project.lang];
		const opts = kindOptions(rc.config, project.dir, kind) || {};
		if (env) opts.env = { ...env, ...opts.env };
		return sha(JSON.stringify([4, process.platform, process.arch, process.version, project.lang, a.version, project.dir, kind, unit.target, a.argsKey(opts, project), a.executionKey?.(rc, project, opts), extra, rc.digest(unit.inputs)]));
	}

	/** Units a request covers, with their current keys. */
	plan(rc, req) {
		return rc.batch(() => {
			let changed;
			if (req.scope === "changed") changed = rc.changedFiles(req.base || undefined);
			else if (req.scope === "files") changed = new Set((req.files ?? []).map((f) => normRel(f)));
			else if (req.changedSet) changed = req.changedSet;
			let gone;
			if (changed) {
				gone = new Set();
				for (const f of changed) if (!rc.has(f)) gone.add(dirOf(f));
			}
			let extra = req.extraKey ?? (req.extraArgs?.length ? JSON.stringify(req.extraArgs) : "");
			if (extra === "[]") extra = "";
			if (req.env) extra += sha(JSON.stringify(Object.entries(req.env).map(([k, v]) => [k, k === "GOWORK" && v.startsWith(`${rc.abs}/`) ? v.slice(rc.abs.length + 1) : v]).sort()));
			const goSel = req.goSelect ? this.resolveGo(rc, req.goSelect).map : undefined;
			const out = [];
			for (const project of this.projects(rc)) {
				if (goSel && (project.lang !== "go" || !goSel.has(project.dir))) continue;
				if (req.langs?.length && !req.langs.includes(project.lang)) continue;
				if (req.projects?.length && !req.projects.some((p) => normRel(p) === project.dir || p === project.id || p === project.name)) continue;
				if (req.select && (project.lang !== req.select.lang || project.dir !== req.select.projectDir)) continue;
				for (const kind of project.kinds) {
					if (req.kinds?.length && !req.kinds.includes(kind)) continue;
					if (req.select && kind !== req.select.kind) continue;
					const sel = goSel ? goSel.get(project.dir) : req.select?.targets ? new Set(req.select.targets) : undefined;
					for (const unit of this.unitsOf(rc, project, kind, req.env, req.extraArgs)) {
						if (sel && !sel.has(unit.target)) continue;
						if (changed && !sel) {
							const hit = unit.inputs.some((f) => changed.has(f)) || (gone.size && unit.inputs.some((f) => gone.has(dirOf(f))));
							if (!hit) continue;
						}
						out.push({ project, kind, unit, uid: `${project.id}|${kind}|${unit.target}`, key: this.keyOf(rc, project, kind, unit, extra, req.env), extra });
					}
				}
			}
			return out;
		});
	}

	/** go package patterns (./..., ./x, import/path/...) relative to a directory -> module dir -> package dirs */
	resolveGo(rc, { cwdRel = ".", patterns = [] }) {
		const g = goGraph(rc);
		const map = new Map();
		const order = [];
		const noTests = [];
		let unsupported = false;
		for (const pat of patterns.length ? patterns : ["."]) {
			let p = pat;
			let recursive = false;
			if (p === "..." || p.endsWith("/...")) {
				recursive = true;
				p = p === "..." ? "." : p.slice(0, -4);
			}
			let hits = [];
			if (p.startsWith(".")) {
				const dir = normRel(`${cwdRel}/${p}`);
				const owner = g.modules.find((m) => isUnder(dir, m.dir));
				hits = owner ? [...g.pkgs.values()].filter((q) => q.module === owner && (recursive ? isUnder(q.dir, dir) : q.dir === dir)) : [];
			} else if (["all", "std", "cmd"].includes(p)) unsupported = true;
			else hits = [...g.pkgs.values()].filter((q) => (recursive ? q.importPath === p || q.importPath.startsWith(`${p}/`) : q.importPath === p));
			if (!hits.length) unsupported = true;
			for (const q of hits.sort((a, b) => a.importPath.localeCompare(b.importPath))) {
				if (order.includes(q.importPath)) continue;
				order.push(q.importPath);
				if (!q.hasTests) noTests.push(q.importPath);
				if (!map.has(q.module.dir)) map.set(q.module.dir, new Set());
				map.get(q.module.dir).add(q.dir);
			}
		}
		return { map, order, noTests, unsupported };
	}

	// ---------- cache ----------

	cachePath(key) {
		return join(this.cacheDir, key.slice(0, 2), `${key}.json`);
	}

	cacheGet(key) {
		let r = this.mem.get(key);
		if (!r) {
			r = loadJson(this.cachePath(key));
			if (r) this.memSet(key, r);
		}
		if (r?.exec && Date.now() - r.at > 24 * 3600000) return undefined;
		return r;
	}

	memSet(key, r) {
		this.mem.delete(key);
		this.mem.set(key, r);
		if (this.mem.size > 20000) this.mem.delete(this.mem.keys().next().value);
	}

	cachePut(key, rec) {
		this.memSet(key, rec);
		try {
			mkdirSync(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
			writeFileSync(this.cachePath(key), JSON.stringify(rec));
		} catch (e) {
			this.log("cache write failed", String(e?.message ?? e));
		}
	}

	pruneCache() {
		const cutoff = Date.now() - this.config.cacheDays * 86400000;
		let n = 0;
		try {
			for (const d of readdirSync(this.cacheDir)) {
				const dir = join(this.cacheDir, d);
				for (const f of readdirSync(dir)) {
					const p = join(dir, f);
					try {
						if (statSync(p).mtimeMs < cutoff) {
							unlinkSync(p);
							n++;
						}
					} catch {}
				}
			}
		} catch {}
		if (n) this.log("pruned", n, "cache entries");
	}

	// ---------- tasks & jobs ----------

	/** Ask for a unit result: cache, join an identical run, or queue a new one. Returns a promise. */
	want(r, item, { priority, speculative, request }) {
		const cached = this.cacheGet(item.key);
		if (cached) {
			if (!speculative) {
				this.stats.cacheHits++;
				this.stats.savedMs += cached.ms ?? 0;
				if (cached.speculative) this.stats.speculativeUsed++;
			}
			return { promise: Promise.resolve({ ...cached, source: cached.root === r.name ? "cache" : "shared" }), cached: true };
		}
		let t = this.inflight.get(item.key);
		if (t) {
			if (!speculative) {
				this.stats.joined++;
				t.speculative = false;
				t.priority = Math.max(t.priority, priority);
			}
			if (speculative) return { promise: Promise.resolve(undefined), joined: true };
			const p = new Promise((res) => t.waiters.push({ res, request }));
			return { promise: p.then((x) => ({ ...x, source: t.root === r ? x.source ?? "ran" : "shared" })), joined: true };
		}
		if (speculative) {
			if ((this.unstable.get(item.uid) ?? 0) >= 2) return undefined;
		}
		t = { key: item.key, uid: item.uid, root: r, project: item.project, kind: item.kind, unit: item.unit, extra: item.extra, extraArgs: item.extraArgs, extraEnv: item.extraEnv, exec: item.exec, priority, speculative, waiters: [], seq: jobSeq++ };
		this.inflight.set(item.key, t);
		this.pending.push(t);
		const p = speculative ? Promise.resolve(undefined) : new Promise((res) => t.waiters.push({ res, request }));
		return { promise: p, queued: true };
	}

	resolveTask(t, result) {
		if (this.inflight.get(t.key) === t) this.inflight.delete(t.key);
		for (const w of t.waiters) w.res(result);
		t.waiters = [];
	}

	cancelRequest(request) {
		request.cancelled = true;
		for (const t of this.inflight.values()) {
			for (const w of t.waiters.filter((w) => w.request === request)) w.res({ status: "error", code: 130, failures: [{ id: `${t.uid}:[cancelled]`, title: "request cancelled", output: "" }] });
			t.waiters = t.waiters.filter((w) => w.request !== request);
			if (!t.waiters.length) { t.speculative = true; t.priority = PRIO.speculative; }
		}
	}

	groupOf(t) {
		if (t.exec) return { name: `exec:${t.exec.projectDir}`, limit: this.config.groups[`exec:${t.exec.projectDir}`] ?? 1 };
		const a = ADAPTERS[t.project.lang];
		const opts = kindOptions(this.config, t.project.dir, t.kind) || {};
		const g = a.group(t.project, t.kind, opts);
		return { name: g.name, limit: this.config.groups[g.name] ?? g.limit };
	}

	loadOk() {
		return loadavg()[0] < CPUS * this.config.speculateMaxLoad;
	}

	/** Scheduling hints only: slow suites can explicitly opt out of the fast lane. */
	laneOf(task) {
		const opts = kindOptions(this.config, task.project?.dir ?? task.exec?.projectDir ?? ".", task.kind) || {};
		const explicit = opts.lane ?? task.project?.meta?.lane;
		if (explicit) return explicit;
		if (!task.exec && ["lint", "vet", "typecheck"].includes(task.kind)) return "fast";
		if (!task.exec && task.project?.lang === "ts" && task.kind === "test") return "fast";
		const command = task.exec?.cmd ?? task.project?.meta?.cmd ?? "";
		if (/\bgo\s+(test|build)\b|\b(pnpm|npm|yarn|bun)\s+(run\s+)?build\b|\btsc\s+(-b|--build)\b/.test(command)) return "heavy";
		return /\b(tsc|vue-tsc|eslint|oxlint|ruff|mypy|pyright)\b|\b(pnpm|npm|yarn|bun)\b[^;&|\n]*\b(type|typecheck|lint)\b|\bnode\b[^;&|\n]*\s--test\b/.test(command) ? "fast" : "heavy";
	}

	laneReserved() {
		return this.config.fastLane && this.config.maxJobs > 1 && this.config.cpuBudget > 1;
	}

	/** Never lend the reserved slot to a long job: late fast work must still fit. */
	allocation(task) {
		const lane = this.laneOf(task), reserved = this.laneReserved();
		const running = [...this.running];
		const peers = running.filter((j) => !reserved || j.lane === lane);
		const limit = reserved ? lane === "fast" ? 1 : this.config.maxJobs - 1 : this.config.maxJobs;
		if (peers.length >= limit) return 0;
		const used = running.reduce((n, j) => n + j.threads, 0);
		const budget = reserved ? lane === "fast" ? 1 : this.config.cpuBudget - 1 : this.config.cpuBudget;
		const available = Math.max(0, Math.min(this.config.cpuBudget - used, budget - peers.reduce((n, j) => n + j.threads, 0)));
		if (!available) return 0;
		const groups = new Map();
		for (const j of this.running) groups.set(j.group.name, (groups.get(j.group.name) ?? 0) + 1);
		let ready = 0;
		for (const t of this.pending) {
			if (reserved && this.laneOf(t) !== lane) continue;
			if (t.speculative && !task.speculative) continue;
			const g = this.groupOf(t), busy = groups.get(g.name) ?? 0;
			if (busy >= g.limit) continue;
			groups.set(g.name, busy + 1);
			ready++;
		}
		const slots = Math.max(1, Math.min(ready, limit - peers.length));
		// Leave capacity for a late requester instead of leasing the whole budget to one job.
		const ceiling = this.config.threads || Math.ceil(budget / Math.min(limit, 2));
		return Math.min(ceiling, Math.max(1, Math.floor(available / slots)));
	}

	pump() {
		if (this.pumping) return;
		if (this.pendingConfig && !this.running.size && !this.pending.some((t) => !t.speculative)) this.applyConfig(this.pendingConfig);
		this.pumping = true;
		try {
			this.pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
			const explicitWaiting = () => this.pending.some((t) => !t.speculative);
			let progress = true;
			while (progress) {
				progress = false;
				const groupsBusy = new Map();
				for (const j of this.running) groupsBusy.set(j.group.name, (groupsBusy.get(j.group.name) ?? 0) + 1);
				for (const t of this.pending) {
					const g = this.groupOf(t);
					const busy = groupsBusy.get(g.name) ?? 0;
					if (t.speculative) {
						if (explicitWaiting() || !this.loadOk()) continue;
						if (this.running.size >= Math.max(1, this.config.maxJobs - 1)) continue; // keep a slot for agents
					}
					const threads = this.allocation(t);
					if (this.running.size >= this.config.maxJobs || busy >= g.limit || !threads) {
						if (!t.speculative) {
							// make room: stop a speculative job in the way
							const victim = [...this.running].find((j) => j.speculativeOnly() && (!this.laneReserved() || j.lane === this.laneOf(t)) && (busy >= g.limit ? j.group.name === g.name : true));
							if (victim) this.abortJob(victim, "preempted by a requested check");
						}
						continue;
					}
					this.startJob(t, g, threads);
					progress = true;
					break;
				}
			}
		} finally {
			this.pumping = false;
		}
	}

	startJob(first, group, threads = this.allocation(first)) {
		const batch = [first];
		if (!first.exec) {
			const max = Math.min(ADAPTERS[first.project.lang].batchSize(first.kind), this.laneReserved() && this.laneOf(first) === "fast" && first.kind === "test" ? 8 : Infinity);
			for (const t of this.pending) {
				if (batch.length >= max) break;
				if (t === first || t.exec) continue;
				if (t.root === first.root && t.project.id === first.project.id && t.kind === first.kind && t.extra === first.extra && t.speculative === first.speculative) batch.push(t);
			}
		}
		this.pending = this.pending.filter((t) => !batch.includes(t));
		const ac = new AbortController();
		const job = {
			id: ++jobSeq,
			root: first.root,
			project: first.project,
			kind: first.exec ? "exec" : first.kind,
			tasks: batch,
			group,
			threads,
			lane: this.laneOf(first),
			ac,
			completed: 0,
			activity: "starting",
			lastOutputAt: Date.now(),
			startedAt: Date.now(),
			inputSet: new Set(batch.flatMap((t) => (t.exec ? t.exec.inputs : t.unit.inputs))),
			speculativeOnly() {
				return this.tasks.every((t) => t.speculative && !t.waiters.length);
			},
			label: first.exec ? `exec: ${first.exec.cmd.slice(0, 60)}` : `${first.project.lang} ${first.project.dir} ${first.kind} (${batch.length} unit${batch.length > 1 ? "s" : ""})`,
		};
		this.running.add(job);
		this.log("start", job.id, job.root.name, job.label, first.speculative ? "speculative" : "");
		this.runJob(job)
			.catch((e) => {
				this.log("job crashed", job.id, String(e?.stack ?? e));
				for (const t of job.tasks) this.resolveTask(t, { status: "error", failures: [{ id: `${t.uid}:[crash]`, title: "pi-check crashed running this check", output: String(e?.stack ?? e).slice(-3000) }] });
			})
			.finally(() => {
				this.running.delete(job);
				this.dirty = true;
				this.pump();
			});
	}

	abortJob(job, why) {
		if (job.ac.signal.aborted) return;
		job.abortReason = why;
		this.stats.preempted++;
		this.log("abort", job.id, job.label, why);
		job.ac.abort();
	}

	async runJob(job) {
		const r = job.root;
		const rc = r.rc;
		const threads = job.threads;
		const nice = this.config.nice;
		if (job.tasks[0].exec) return this.runExecJob(job, threads, nice);
		const { project, kind } = job;
		const a = ADAPTERS[project.lang];
		const opts = kindOptions(this.config, project.dir, kind) || {};
		if (job.tasks[0].extraEnv) opts.env = { ...job.tasks[0].extraEnv, ...opts.env };
		// A joined request owns this snapshot, not whatever the producer edits next.
		const live = [];
		rc.invalidate(true);
		rc.batch(() => {
			for (const t of job.tasks) {
				const unit = this.unitsOf(rc, project, kind, t.extraEnv, t.extraArgs).find((u) => u.target === t.unit.target);
				if (!unit) {
					this.resolveTask(t, { status: "error", failures: [{ id: `${t.uid}:[gone]`, title: `${t.unit.target} no longer exists`, output: "" }] });
					continue;
				}
				const k = this.keyOf(rc, project, kind, unit, t.extra, t.extraEnv);
				if (k !== t.key) {
					this.resolveTask(t, { status: "error", stale: true, failures: [] });
					continue;
				}
				t.unit = unit;
				live.push(t);
			}
		});
		if (!live.length) return;
		job.tasks = live;
		job.inputSet = new Set(live.flatMap((t) => t.unit.inputs));
		const baseClean = r.abs === this.main ? this.baseIsClean(rc) : undefined;
		const finalized = new Set();
		const byTarget = new Map(live.map((t) => [t.unit.target, t]));
		const finalize = (t, result, ms) => {
			if (finalized.has(t)) return;
			finalized.add(t);
			job.completed++;
			rc.invalidate(true);
			const current = this.unitsOf(rc, project, kind, t.extraEnv, t.extraArgs).find((u) => u.target === t.unit.target);
			const after = current && rc.batch(() => this.keyOf(rc, project, kind, current, t.extra, t.extraEnv));
			const rec = { ...result, key: t.key, uid: t.uid, lang: project.lang, project: project.dir, kind, target: t.unit.target, label: t.unit.label, ms, at: Date.now(), root: r.name, speculative: t.speculative && !t.waiters.length };
			if (t.speculative && !t.waiters.length) this.stats.speculativeRan++;
			else this.stats.ran++;
			if (after === t.key) {
				if (result.status !== "error") this.cachePut(t.key, rec);
				if (result.status !== "error") {
					if (baseClean) this.updateKnown(rec, this.baseIsClean(rc) ?? { dirty: new Set(current.inputs) }, current.inputs);
					else this.noteIfBase(r, project, kind, t, rec);
				}
				this.unstable.delete(t.uid);
				this.resolveTask(t, { ...rec, source: "ran" });
				return;
			}
			this.unstable.set(t.uid, (this.unstable.get(t.uid) ?? 0) + 1);
			this.resolveTask(t, { ...rec, source: "ran", stale: true });
		};
		const onUnit = (target, result) => {
			const t = byTarget.get(target);
			if (t && !job.ac.signal.aborted) finalize(t, result, Math.round((result.seconds ?? 0) * 1000));
		};
		const onProgress = (activity) => { job.activity = activity; job.lastOutputAt = Date.now(); };
		const res = await a.run({ rc, project, kind, units: live.map((t) => t.unit), opts, threads, signal: job.ac.signal, nice, tmpDir: this.tmpDir, extraArgs: live[0].extraArgs ?? [], onUnit, onProgress });
		const per = Math.round((res.ms ?? 0) / live.length);
		if (job.ac.signal.aborted) {
			const preempted = String(job.abortReason ?? "").startsWith("preempted");
			for (const t of live) {
				if (finalized.has(t)) continue;
				if (this.inflight.get(t.key) === t) this.inflight.delete(t.key);
				if (t.waiters.length || preempted) {
					// someone needs it, or it only made room for a requested check: run again later
					if (t.waiters.length) t.speculative = false;
					this.inflight.set(t.key, t);
					this.pending.push(t);
				}
			}
			return;
		}
		this.stats.ranMs += res.ms ?? 0;
		for (const t of live) {
			const result = res.results.get(t.unit.target) ?? { status: "error", failures: [{ id: `${t.uid}:[no result]`, title: `${t.unit.label}: no result from ${project.lang} ${kind}`, output: "" }] };
			finalize(t, result, result.seconds ? Math.round(result.seconds * 1000) : per);
		}
	}

	/**
	 * A failure in a worktree that is not known yet: does the same unit fail on the base branch too?
	 * Look at (or run) the base checkout's version of that unit, so agents never chase old failures.
	 */
	async confirmBase(r, results, emit, req = {}) {
		const unknown = results.filter(({ res }) => res && res.status === "fail" && (res.failures ?? []).some((f) => !this.known.ids[f.id]));
		if (!unknown.length) return;
		const m = this.root(this.main);
		m.rc.invalidate(true);
		const base = this.baseIsClean(m.rc);
		if (!base) return;
		const waits = [];
		m.rc.batch(() => {
			for (const { it } of unknown.slice(0, 60)) {
				const mp = this.projects(m.rc).find((x) => x.id === it.project.id);
				const mu = mp && this.unitsOf(m.rc, mp, it.kind, req.env, req.extraArgs).find((u) => u.target === it.unit.target);
				if (!mu || mu.inputs.some((f) => base.dirty.has(f))) continue;
				const key = this.keyOf(m.rc, mp, it.kind, mu, it.extra, req.env);
				const hit = this.cacheGet(key);
				if (hit) {
					if (hit.status !== "error") this.updateKnown({ ...hit, uid: it.uid, project: mp.dir, kind: it.kind }, base, mu.inputs);
					continue;
				}
				const w = this.want(m, { project: mp, kind: it.kind, unit: mu, uid: it.uid, key, extra: it.extra, extraArgs: req.extraArgs, extraEnv: req.env }, { priority: PRIO.normal, speculative: false, request: req });
				if (w) waits.push(w.promise);
			}
		});
		if (!waits.length) return;
		emit?.({ type: "progress", text: `checking whether ${waits.length} failing unit(s) also fail on the base branch` });
		this.pump();
		await Promise.all(waits);
	}

	/** A result from a worktree whose inputs are identical to the base branch tip counts as a base result too. */
	noteIfBase(r, project, kind, t, rec) {
		try {
			const m = this.root(this.main);
			m.rc.invalidate(true);
			const base = this.baseIsClean(m.rc);
			if (!base) return;
			const mp = this.projects(m.rc).find((x) => x.id === project.id);
			const mu = mp && this.unitsOf(m.rc, mp, kind, t.extraEnv, t.extraArgs).find((u) => u.target === t.unit.target);
			if (!mu) return;
			if (m.rc.batch(() => this.keyOf(m.rc, mp, kind, mu, t.extra, t.extraEnv)) === t.key) this.updateKnown(rec, base, mu.inputs);
		} catch {}
	}

	/** Main checkout on the base branch tip, and which of its files are uncommitted. */
	baseIsClean(rc) {
		const head = rc.head();
		const base = git(rc.abs, ["rev-parse", rc.baseRef()]);
		if (!base.ok || base.out.trim() !== head) return undefined;
		return { dirty: rc.dirtyFiles(), head };
	}

	updateKnown(rec, base, inputs) {
		if (rec.exec || inputs.some((f) => base.dirty.has(f))) return;
		const ids = this.known.ids;
		let changed = false;
		for (const [id, k] of Object.entries(ids)) {
			if (k.uid === rec.uid && k.source === "base" && !rec.failures.some((f) => f.id === id)) {
				delete ids[id];
				changed = true;
			}
		}
		for (const f of rec.failures ?? []) {
			if (!ids[f.id]) {
				ids[f.id] = { uid: rec.uid, project: rec.project, kind: rec.kind, title: f.title, source: "base", since: Date.now(), head: base.head };
				changed = true;
			} else ids[f.id].seen = Date.now();
		}
		if (changed) this.saveKnown();
	}

	saveKnown() {
		writeJson(join(this.dir, "known.json"), this.known);
	}

	// ---------- exec (whole commands agents run in bash) ----------

	execPlan(r, cwdAbs, cmd, env) {
		const rc = r.rc;
		let eff = cwdAbs.startsWith(rc.abs) ? normRel(cwdAbs.slice(rc.abs.length + 1)) : ".";
		const cdm = cmd.match(/^\s*cd\s+(["']?)([^"'&;|]+?)\1\s*(&&|;)/);
		if (cdm && !cdm[2].startsWith("/") && !cdm[2].startsWith("~")) eff = normRel(`${eff}/${cdm[2]}`);
		const dirs = this.projects(rc)
			.map((p) => p.dir)
			.filter((d) => isUnder(eff, d))
			.sort((a, b) => b.length - a.length);
		const projectDir = dirs[0] ?? eff;
		const inputs = [...rc.filesUnder(projectDir), ...rootLockfiles(rc), ...["package.json", "go.work"].filter((f) => rc.has(f))];
		const cwdRel = cwdAbs.startsWith(rc.abs) ? normRel(cwdAbs.slice(rc.abs.length + 1)) : ".";
		const key = rc.batch(() => sha(JSON.stringify(["exec", 3, process.platform, process.arch, process.version, cmd, cwdRel, env ? Object.entries(env).sort() : [], rc.digest(inputs)])));
		return { key, projectDir, inputs, cwdRel };
	}

	async runExecJob(job, threads, nice) {
		const t = job.tasks[0];
		const rc = job.root.rc;
		// A broker-owned shell already holds a CPU lease. Nested shims execute inside that
		// lease rather than requesting a second slot and deadlocking maxJobs=1.
		const env = cleanEnv({ CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", PY_COLORS: "0", ...t.exec.env, PI_CHECK_BYPASS: "1", GOMAXPROCS: String(threads), GOFLAGS: `${t.exec.env?.GOFLAGS ?? process.env.GOFLAGS ?? ""} -p=1`.trim() });
		const r = await runProc({ cmd: "/bin/sh", args: ["-c", t.exec.cmd], cwd: rc.path(t.exec.cwdRel), env, signal: job.ac.signal, nice, timeoutMs: parseDuration(this.config.execTimeout, 45 * 60000), maxBytes: 2 * 1024 * 1024 });
		if (job.ac.signal.aborted) {
			if (this.inflight.get(t.key) === t) this.inflight.delete(t.key);
			if (t.waiters.length) {
				t.speculative = false;
				this.inflight.set(t.key, t);
				this.pending.push(t);
			}
			return;
		}
		this.stats.execRuns++;
		this.stats.ranMs += r.ms;
		rc.invalidate(true);
		const again = this.execPlan(job.root, rc.path(t.exec.cwdRel), t.exec.cmd, t.exec.env);
		const rec = { exec: true, key: t.key, code: r.code, output: `${r.stdout}${r.stderr ? (r.stdout ? "\n" : "") + r.stderr : ""}`, ms: r.ms, at: Date.now(), root: job.root.name, cmd: t.exec.cmd, killed: r.killed };
		if (t.exec.cache && again.key === t.exec.inputKey && !r.killed && !/panic: test timed out after/.test(rec.output)) this.cachePut(t.key, rec);
		this.resolveTask(t, { ...rec, source: "ran", stale: again.key !== t.exec.inputKey });
	}

	async exec(req, emit) {
		this.lastUse = Date.now();
		const r = this.root(req.root);
		this.refreshRoot(r);
		const p = this.execPlan(r, req.cwd ?? r.abs, req.cmd, req.env);
		// Measurements and artifact-producing commands must actually execute in each requesting checkout.
		const cache = req.cache !== false && !/(?:^|[\s'"])-(?:test\.)?(?:c|o|bench\w*|fuzz\w*|\w*profile|trace|outputdir|count)(?:=|[\s'"]|$)|--(?:coverage|output)|(?:^|\s)(?:>>?|tee)\s/.test(req.cmd);
		const hit = cache && this.cacheGet(p.key);
		if (hit) {
			this.stats.execHits++;
			this.stats.savedMs += hit.ms ?? 0;
			return { ...hit, source: hit.root === r.name ? "cache" : "shared" };
		}
		const w = this.want(r, { key: cache ? p.key : sha(`${p.key}:${randomBytes(16).toString("hex")}`), uid: `exec|${p.cwdRel}|${req.cmd}`, exec: { cmd: req.cmd, cwdRel: p.cwdRel, projectDir: p.projectDir, inputs: p.inputs, inputKey: p.key, cache, env: req.env } }, { priority: req.priority ?? PRIO.normal, speculative: false, request: req });
		const tick = setInterval(() => emit?.({ type: "progress", text: this.waitingText(r) }), 5000);
		this.pump();
		try {
			const result = await w.promise;
			r.rc.invalidate(true);
			return { ...result, stale: result.stale || this.execPlan(r, req.cwd ?? r.abs, req.cmd, req.env).key !== p.key };
		} finally {
			clearInterval(tick);
		}
	}

	waitingText(r) {
		const running = [...this.running].map((j) => `${j.root.name}: ${j.label} [${j.lane}; ${fmtMs(Date.now() - j.startedAt)}, ${j.threads} CPU budget, ${j.completed}/${j.tasks.length} complete; ${j.activity}]`);
		return `running: ${running.join("; ") || "nothing"} · queued units: ${this.pending.filter((t) => !t.speculative).length}`;
	}

	// ---------- requests ----------

	async run(req, emit) {
		this.lastUse = Date.now();
		this.stats.requests++;
		const started = Date.now();
		const r = this.root(req.root);
		this.refreshRoot(r);
		if (req.reloadConfig) this.reload();
		if (req.goSelect) {
			const selected = this.resolveGo(r.rc, req.goSelect);
			if (selected.unsupported) return { ...this.report(r, req, [], Date.now() - started), ok: false, go: selected };
		}
		const items = this.plan(r.rc, req);
		this.stats.unitsAsked += items.length;
		const priority = req.priority ?? PRIO.normal;
		const waits = [];
		let cached = 0;
		let joined = 0;
		let queued = 0;
		for (const it of items) {
			if (req.refresh) {
				this.mem.delete(it.key);
				try {
					rmSync(this.cachePath(it.key), { force: true });
				} catch {}
			}
			const w = this.want(r, { ...it, extraArgs: req.extraArgs, extraEnv: req.env }, { priority, speculative: false, request: req });
			if (w.cached) cached++;
			else if (w.joined) joined++;
			else queued++;
			waits.push(w.promise.then((res) => ({ it, res })));
		}
		emit?.({ type: "start", units: items.length, cached, joined, queued });
		this.pump();
		let done = 0;
		const tick = setInterval(() => emit?.({ type: "progress", done, total: items.length, text: this.waitingText(r) }), 4000);
		let results;
		try {
			results = await Promise.all(waits.map((p) => p.then((x) => (done++, x))));
		} finally { clearInterval(tick); }
		if (!req.cancelled && r.abs !== this.main && !(req.strict ?? this.config.strict)) await this.confirmBase(r, results, emit, req);
		// Revalidate after every wait, including baseline classification.
		if (!req.cancelled) {
			r.rc.invalidate(true);
			const current = new Map(this.plan(r.rc, req).map((it) => [it.uid, it.key]));
			const added = [...current.keys()].some((uid) => !items.some((it) => it.uid === uid));
			for (const row of results) if (added || current.get(row.it.uid) !== row.it.key) row.res = { ...row.res, stale: true };
		}
		if (r.abs === this.main) {
			// results on the base branch (cached or fresh) define what is "pre-existing"
			const base = this.baseIsClean(r.rc);
			if (base) for (const { it, res } of results) if (res && res.status !== "error" && !res.stale && !res.exec) this.updateKnown({ ...res, uid: it.uid, project: it.project.dir, kind: it.kind }, base, it.unit.inputs);
		}
		const report = this.report(r, req, results, Date.now() - started);
		if (req.goSelect) {
			const gs = this.resolveGo(r.rc, req.goSelect);
			report.go = { order: gs.order, noTests: gs.noTests, unsupported: gs.unsupported };
		}
		this.recent.unshift({ at: Date.now(), root: r.name, scope: req.scope ?? "changed", units: items.length, ok: report.ok, newFailures: report.newFailures, ms: report.ms, label: req.label ?? "" });
		this.recent = this.recent.slice(0, 50);
		this.dirty = true;
		return report;
	}

	report(r, req, results, ms) {
		const strict = req.strict ?? this.config.strict;
		const groups = new Map();
		let newFailures = 0;
		let knownFailures = 0;
		let errors = 0;
		const src = { cache: 0, shared: 0, ran: 0 };
		for (const { it, res } of results) {
			const k = `${it.project.lang} ${it.project.dir} · ${it.kind}`;
			let g = groups.get(k);
			if (!g) groups.set(k, (g = { lang: it.project.lang, project: it.project.dir, kind: it.kind, total: 0, pass: 0, fail: 0, new: [], known: [], fixed: 0, notes: [] }));
			g.total++;
			src[res?.source === "shared" ? "shared" : res?.source === "cache" ? "cache" : "ran"]++;
			if (!res) {
				g.fail++;
				errors++;
				continue;
			}
			if (res.stale) {
				g.fail++;
				errors++;
				newFailures++;
				g.new.push({ title: `${it.unit.label}: inputs changed during execution; result is not current`, stale: true });
				continue;
			}
			if (res.status === "pass") {
				g.pass++;
				for (const [, kn] of Object.entries(this.known.ids)) if (kn.uid === it.uid) g.fixed++;
				continue;
			}
			g.fail++;
			if (res.status === "error") errors++;
			for (const f of res.failures ?? []) {
				if (!strict && this.known.ids[f.id] && res.status !== "error") {
					g.known.push(f);
					knownFailures++;
				} else {
					g.new.push({ ...f, unit: it.unit.label, stale: res.stale });
					newFailures++;
				}
			}
			if (res.note) g.notes.push(res.note);
		}
		const ok = newFailures === 0 && errors === 0;
		const lines = [];
		const scopeText = req.select ? "selected" : req.scope === "all" ? "all" : req.scope === "files" ? `files (${req.files?.length ?? 0})` : `changed vs ${req.base || r.rc.baseRef()}`;
		lines.push(`pi-check · ${r.name} · scope: ${scopeText} · ${results.length} unit${results.length === 1 ? "" : "s"}: ${src.ran} ran, ${src.cache} cached, ${src.shared} shared · ${fmtMs(ms)}`);
		if (!results.length) lines.push("Nothing to check: no test, type or lint unit depends on the changed files.");
		let shown = 0;
		for (const g of [...groups.values()].sort((a, b) => b.new.length - a.new.length)) {
			const head = `${g.new.length ? "✗" : "✓"} ${g.lang} ${g.project} · ${g.kind}: ${g.pass}/${g.total} pass`;
			const extra = [g.known.length ? `${g.known.length} pre-existing failure${g.known.length > 1 ? "s" : ""} (also fail on base)` : "", g.fixed ? `${g.fixed} known failure${g.fixed > 1 ? "s" : ""} now pass` : ""].filter(Boolean).join(", ");
			lines.push(`${head}${extra ? ` — ${extra}` : ""}`);
			for (const f of g.new) {
				if (shown >= 15) continue;
				shown++;
				lines.push(`   ✗ ${f.title}${f.stale ? " (files changed during the run — rerun to confirm)" : ""}`);
				if (f.output) lines.push(...tailLines(headLines(f.output, 60), 30).split("\n").map((l) => `     ${l}`));
			}
		}
		if (newFailures > shown) lines.push(`… ${newFailures - shown} more new failures (pi-check run --json for all)`);
		if (knownFailures && !strict) lines.push(`Pre-existing failures are not caused by these changes and do not fail the check (strict: true to count them).`);
		lines.push(ok ? `RESULT: PASS${knownFailures ? ` (${knownFailures} pre-existing failures ignored)` : ""}` : `RESULT: FAIL — ${newFailures} new failure${newFailures === 1 ? "" : "s"}${errors ? ` (${errors} could not run)` : ""}`);
		const out = { ok, ms, units: results.length, ...src, newFailures, knownFailures, errors, groups: [...groups.values()], text: lines.join("\n") };
		if (req.detail) out.results = results.map(({ it, res }) => ({ project: it.project.dir, lang: it.project.lang, kind: it.kind, target: it.unit.target, label: it.unit.label, ...res, known: (res?.failures ?? []).filter((f) => this.known.ids[f.id]).map((f) => f.id) }));
		return out;
	}

	speculate(r, changedSet, priority = PRIO.speculative) {
		if (!this.loadOk() || this.pending.some((t) => !t.speculative)) return 0;
		let items;
		try {
			items = this.plan(r.rc, { changedSet });
		} catch (e) {
			this.log("speculate plan failed", String(e?.stack ?? e));
			return 0;
		}
		let n = 0;
		for (const it of items) {
			if (n >= 400) break;
			if (this.cacheGet(it.key) || this.inflight.has(it.key)) continue;
			if (this.want(r, it, { priority, speculative: true })) n++;
		}
		if (n) this.log("speculating", r.name, n, "units");
		this.pump();
		return n;
	}

	/** Watch every worktree of the repo (queue worktrees appear and disappear). */
	scanWorktrees() {
		const l = git(this.main, ["worktree", "list", "--porcelain"]);
		if (!l.ok) return;
		for (const line of l.out.split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const p = line.slice(9).trim();
			if (!existsSync(p) || this.roots.has(p)) continue;
			try {
				this.root(p);
			} catch {}
		}
	}

	warm() {
		const r = this.root(this.main);
		r.rc.invalidate(true);
		const items = this.plan(r.rc, { scope: "all" });
		const base = this.baseIsClean(r.rc);
		let n = 0;
		for (const it of items) {
			const hit = this.cacheGet(it.key);
			if (hit) {
				if (base && hit.status !== "error") this.updateKnown({ ...hit, uid: it.uid, project: it.project.dir, kind: it.kind }, base, it.unit.inputs);
				continue;
			}
			if (!this.inflight.has(it.key) && this.want(r, it, { priority: PRIO.warm, speculative: true })) n++;
		}
		this.log("warm", n, "of", items.length, "units uncached on main");
		this.pump();
		return n;
	}

	reload() {
		const config = loadConfig(this.main);
		if (this.running.size || this.pending.some((t) => !t.speculative)) {
			this.pendingConfig = config;
			return { deferred: true };
		}
		this.applyConfig(config);
		return { deferred: false };
	}

	applyConfig(config) {
		this.cancel(); // only optional queued work; requested work has drained
		this.config = config;
		this.pendingConfig = undefined;
		for (const r of new Set(this.roots.values())) {
			r.rc.config = this.config;
			r.rc.invalidate(true);
			if (config.watch) this.watchRoot(r);
			else this.unwatch(r);
		}
		this.log("configuration applied at idle boundary");
	}

	status() {
		const roots = [...new Set(this.roots.values())].map((r) => ({ name: r.name, abs: r.abs, watching: r.watching, idle: fmtMs(Date.now() - r.lastUse) }));
		return {
			pid: process.pid,
			version: VERSION,
			scheduler: "lanes-v2",
			fastLane: !!this.laneReserved(),
			lanes: Object.fromEntries(["fast", "heavy"].map((lane) => [lane, {
				running: [...this.running].filter((j) => j.lane === lane).length,
				queued: this.pending.filter((t) => !t.speculative && this.laneOf(t) === lane).length,
			}])),
			main: this.main,
			uptime: fmtMs(Date.now() - this.startedAt),
			maxJobs: this.config.maxJobs,
			threads: this.config.threads,
			cpuBudget: this.config.cpuBudget,
			allocatedCpus: [...this.running].reduce((n, j) => n + j.threads, 0),
			configPending: !!this.pendingConfig,
			cpus: CPUS,
			load: Number(loadavg()[0].toFixed(2)),
			speculate: this.config.speculate,
			running: [...this.running].map((j) => ({ id: j.id, root: j.root.name, label: j.label, lane: j.lane, threads: j.threads, completed: j.completed, units: j.tasks.length, activity: j.activity, outputAgo: fmtMs(Date.now() - j.lastOutputAt), speculative: j.speculativeOnly(), for: fmtMs(Date.now() - j.startedAt) })),
			pending: { requested: this.pending.filter((t) => !t.speculative).length, speculative: this.pending.filter((t) => t.speculative).length },
			roots,
			stats: { ...this.stats, saved: fmtMs(this.stats.savedMs), spent: fmtMs(this.stats.ranMs) },
			known: Object.keys(this.known.ids).length,
			recent: this.recent.slice(0, 10),
		};
	}

	persist() {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			writeJson(join(this.dir, "state.json"), { stats: this.stats, recent: this.recent, status: { running: [...this.running].map((j) => ({ root: j.root.name, label: j.label })), at: Date.now() } });
		} catch {}
	}

	cancel(rootAbs) {
		let n = 0;
		for (const t of [...this.pending]) {
			if (rootAbs && t.root.abs !== rootAbs) continue;
			if (t.speculative) {
				this.pending.splice(this.pending.indexOf(t), 1);
				if (this.inflight.get(t.key) === t) this.inflight.delete(t.key);
				n++;
			}
		}
		for (const j of this.running) if ((!rootAbs || j.root.abs === rootAbs) && j.speculativeOnly()) this.abortJob(j, "cancelled"), n++;
		return n;
	}
}

// ---------- server ----------

function readBody(req) {
	return new Promise((res) => {
		let b = "";
		req.on("data", (d) => (b += d));
		req.on("end", () => {
			try {
				res(b ? JSON.parse(b) : {});
			} catch {
				res({});
			}
		});
	});
}

export async function serve(main) {
	const dir = ensureDir(join(main, STATE_DIR));
	const lockPath = join(dir, "broker.lock");
	// single instance per repo
	try {
		const fd = openSync(lockPath, "wx");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
	} catch {
		const other = Number(loadJson(join(dir, "broker.json"), {})?.pid) || Number(String(require_text(lockPath)).trim());
		if (pidAlive(other) && other !== process.pid) {
			process.exit(0);
		}
		writeFileSync(lockPath, String(process.pid));
	}
	ensureExcluded(main);
	adoptLoginPath();
	const b = new Broker(main);
	const token = randomBytes(16).toString("hex");
	const server = http.createServer(async (req, res) => {
		if (req.headers["x-pi-check-token"] !== token) {
			res.writeHead(403).end();
			return;
		}
		const url = new URL(req.url, "http://x");
		const body = req.method === "POST" ? await readBody(req) : {};
		const json = (code, obj) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		const stream = () => {
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			let open = true;
			res.on("close", () => {
				open = false;
				b.cancelRequest(body);
			});
			return (o) => open && res.write(`${JSON.stringify(o)}\n`);
		};
		try {
			switch (url.pathname) {
				case "/ping":
					return json(200, { ok: true, pid: process.pid, version: VERSION });
				case "/status":
					return json(200, b.status());
				case "/touch":
					b.root(body.root ?? main);
					return json(200, { ok: true });
				case "/projects": {
					const r = b.root(body.root ?? main);
					r.rc.invalidate(true);
					return json(200, { projects: b.projects(r.rc).map((p) => ({ ...p, units: Object.fromEntries(p.kinds.map((k) => [k, b.unitsOf(r.rc, p, k).length])) })) });
				}
				case "/run": {
					const emit = stream();
					const rep = await b.run(body, emit);
					emit({ type: "result", report: rep });
					return res.end();
				}
				case "/exec": {
					const emit = stream();
					const rep = await b.exec(body, emit);
					emit({ type: "result", ...rep });
					return res.end();
				}
				case "/known": {
					const ids = b.known.ids;
					if (body.action === "add") for (const id of body.ids ?? []) ids[id] = { source: "manual", since: Date.now(), title: id, uid: "" };
					else if (body.action === "remove") {
						for (const id of Object.keys(ids)) if ((body.ids ?? []).includes(id) || (body.pattern && id.includes(body.pattern))) delete ids[id];
					} else if (body.action === "clear") b.known.ids = {};
					if (body.action) b.saveKnown();
					return json(200, { known: b.known.ids });
				}
				case "/speculate": {
					const r = b.root(body.root ?? main);
					r.rc.invalidate(true);
					const n = body.all ? (r.abs === main ? b.warm() : b.speculate(r, new Set(r.rc.listing().files))) : b.speculate(r, r.rc.changedFiles());
					return json(200, { queued: n });
				}
				case "/cancel":
					return json(200, { cancelled: b.cancel(body.root) });
				case "/reload":
					return json(200, { ok: true, ...b.reload(), config: b.config });
				case "/forget": {
					b.mem.clear();
					rmSync(b.cacheDir, { recursive: true, force: true });
					ensureDir(b.cacheDir);
					return json(200, { ok: true });
				}
				case "/stop":
					json(200, { ok: true });
					return shutdown("stop requested");
				default:
					return json(404, { error: "unknown endpoint" });
			}
		} catch (e) {
			b.log("request failed", url.pathname, String(e?.stack ?? e));
			if (!res.headersSent) json(500, { error: String(e?.message ?? e) });
			else res.end(`${JSON.stringify({ type: "error", error: String(e?.message ?? e) })}\n`);
		}
	});
	await new Promise((res) => server.listen(0, "127.0.0.1", res));
	const port = server.address().port;
	writeJson(join(dir, "broker.json"), { pid: process.pid, port, token, version: VERSION, main, startedAt: Date.now() });
	b.log(`broker ${VERSION} up on ${port} (cpus ${CPUS}, maxJobs ${b.config.maxJobs}, threads ${b.config.threads})`);
	b.root(main);
	b.scanWorktrees();
	setTimeout(() => b.pruneCache(), 30000).unref();
	if (b.config.warmBase && b.config.speculate) setTimeout(() => b.warm(), 1500);
	const timers = [
		setInterval(() => b.persist(), 5000),
		setInterval(() => {
			for (const r of new Set(b.roots.values())) if (r.abs !== main && (!existsSync(r.abs) || Date.now() - r.lastUse > 3 * 3600000)) b.dropRoot(r);
			if (b.config.watch) b.scanWorktrees();
			if (Date.now() - b.lastUse > b.config.idleMinutes * 60000 && !b.running.size && !b.pending.some((t) => !t.speculative)) shutdown("idle");
			b.pump();
		}, 30000),
	];
	function shutdown(why) {
		b.log("shutdown:", why);
		for (const t of timers) clearInterval(t);
		for (const j of b.running) j.ac.abort();
		b.dirty = true;
		b.persist();
		try {
			unlinkSync(join(dir, "broker.json"));
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
		server.close();
		setTimeout(() => process.exit(0), 300).unref();
	}
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("uncaughtException", (e) => b.log("uncaught", String(e?.stack ?? e)));
	process.on("unhandledRejection", (e) => b.log("unhandled", String(e?.stack ?? e)));
	return b;
}

function require_text(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

/** Keep .pi-check/ out of git status in every checkout. */
export function ensureExcluded(main) {
	const c = git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!c.ok) return;
	const f = join(c.out.trim(), "info", "exclude");
	try {
		mkdirSync(join(c.out.trim(), "info"), { recursive: true });
		const t = existsSync(f) ? readFileSync(f, "utf8") : "";
		if (!t.split("\n").includes("/.pi-check/")) writeFileSync(f, `${t}${t && !t.endsWith("\n") ? "\n" : ""}/.pi-check/\n`);
	} catch {}
}

if (process.argv[1] && process.argv[1].endsWith("broker.mjs") && process.argv[2]) {
	serve(process.argv[2]).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
