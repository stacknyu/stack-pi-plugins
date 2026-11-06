// A checkout (main repo or a worktree): its file listing, content digests, changed files, and the repo config.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CPUS, STATE_DIR, FileHasher, git, isUnder, loadJson, matchAny, sha } from "./util.mjs";

export const CONFIG_FILE = "pi-check.json";

const ALWAYS_SKIP = [".pi-queue/", ".pi-check/", ".pi-flow/", ".tasks/", ".git/"];

export const DEFAULTS = {
	maxJobs: 0, // 0 = available CPUs; independent from the number of agent sessions
	cpuBudget: 0, // 0 = all available CPUs; a shared budget, not a utilization target
	threads: 0, // 0 = divide spare budget among runnable jobs; positive = per-job ceiling
	fastLane: true, // reserve one job slot and CPU for short checks when capacity permits
	nice: 10,
	watch: true,
	speculate: true, // run affected checks ahead of time when files change
	warmBase: false, // opt in to a full baseline warm-up; normal speculation is affected-only
	speculateMaxLoad: 0.75, // only speculate while load average < cores * this
	debounceMs: 2500,
	intercept: "route", // route | block | off: what happens to raw test commands agents run in bash
	shimGo: true, // `go test` / `go vet` inside agent shells go through the broker
	base: "", // base branch for "changed" scope; default: the branch the main checkout is on
	ignore: [], // globs never treated as check inputs (generated output, data dirs)
	languages: { go: true, ts: true, python: true },
	projects: {}, // "<dir>": { inputs: [...], exclude: [...], <kind>: false | { args, env, timeout, parallel, cmd, inputs } }
	custom: [], // [{ name, cwd, cmd, inputs: [globs], timeout, env, parallel }]
	groups: {}, // concurrency per group name, overrides defaults
	idleMinutes: 180,
	cacheDays: 21,
	strict: false, // true: failures that also fail on the base branch still fail the check
};

export function loadConfig(main) {
	const shared = loadJson(join(main, CONFIG_FILE), {}) ?? {};
	const local = loadJson(join(main, STATE_DIR, "config.json"), {}) ?? {};
	const c = { ...DEFAULTS, ...shared, ...local };
	c.languages = { ...DEFAULTS.languages, ...(shared.languages ?? {}), ...(local.languages ?? {}) };
	c.projects = { ...(shared.projects ?? {}), ...(local.projects ?? {}) };
	c.groups = { ...(shared.groups ?? {}), ...(local.groups ?? {}) };
	c.custom = [...(shared.custom ?? []), ...(local.custom ?? [])];
	for (const key of ["cpuBudget", "maxJobs", "threads"]) {
		if (!Number.isInteger(c[key]) || c[key] < 0) throw new Error(`${key} must be a non-negative integer`);
	}
	c.cpuBudget = c.cpuBudget || CPUS;
	c.maxJobs = Math.min(c.maxJobs || c.cpuBudget, c.cpuBudget);
	if (typeof c.fastLane !== "boolean") throw new Error("fastLane must be a boolean");
	const laneOptions = [...c.custom, ...Object.values(c.projects).flatMap((p) => [p.test, p.vet, p.lint, p.typecheck, p.custom])];
	for (const opts of laneOptions) if (opts?.lane !== undefined && !["fast", "heavy"].includes(opts.lane)) throw new Error("lane must be fast or heavy");
	return c;
}

/** Per-project, per-kind options. `false` disables the kind. */
export function kindOptions(config, projectDir, kind) {
	const p = config.projects?.[projectDir] ?? config.projects?.[projectDir === "." ? "" : projectDir] ?? {};
	const k = p[kind];
	if (k === false) return false;
	return { ...(k && typeof k === "object" ? k : {}), inputs: [...(p.inputs ?? []), ...((k && k.inputs) || [])], exclude: [...(p.exclude ?? []), ...((k && k.exclude) || [])] };
}

export class RootCtx {
	constructor(abs, main, hasher = new FileHasher(), config = loadConfig(main)) {
		this.abs = abs;
		this.main = main;
		this.isMain = abs === main;
		this.hasher = hasher;
		this.config = config;
		this._listing = undefined;
		this.version = 0;
		this.memo = new Map(); // adapter memos, cleared on change
	}

	invalidate(structural = true) {
		this.version++;
		if (structural) this._listing = undefined;
		this.memo.clear();
	}

	path(r) {
		return r === "." ? this.abs : join(this.abs, r);
	}

	/** All files git would see (tracked + untracked, not ignored, not deleted), repo-relative. */
	listing() {
		if (this._listing) return this._listing;
		const a = git(this.abs, ["ls-files", "-co", "--exclude-standard", "-z"]);
		const d = git(this.abs, ["ls-files", "-d", "-z"]);
		const deleted = new Set(d.out.split("\0").filter(Boolean));
		const ignore = this.config.ignore ?? [];
		const files = [];
		const seen = new Set();
		for (const f of a.out.split("\0")) {
			if (!f || deleted.has(f) || seen.has(f)) continue;
			if (ALWAYS_SKIP.some((s) => f.startsWith(s))) continue;
			if (ignore.length && matchAny(ignore, f)) continue;
			seen.add(f);
			files.push(f);
		}
		files.sort();
		this._listing = { files, set: seen, at: Date.now() };
		return this._listing;
	}

	has(r) {
		return this.listing().set.has(r);
	}

	filesUnder(dir, filter) {
		const out = [];
		for (const f of this.listing().files) if (isUnder(f, dir) && (!filter || filter(f))) out.push(f);
		return out;
	}

	hash(r) {
		if (this._hc) {
			let h = this._hc.get(r);
			if (h === undefined) this._hc.set(r, (h = this.hasher.hash(this.path(r))));
			return h;
		}
		return this.hasher.hash(this.path(r));
	}

	/** Within fn, each file is stat'ed at most once (many units share inputs). */
	batch(fn) {
		const outer = this._hc;
		if (!outer) this._hc = new Map();
		try {
			return fn();
		} finally {
			if (!outer) this._hc = undefined;
		}
	}

	text(r) {
		return this.hasher.text(this.path(r));
	}

	/** Digest of a set of repo-relative files: same contents => same digest, in any checkout. */
	digest(files) {
		const list = [...new Set(files)].sort();
		const h = [];
		for (const f of list) h.push(`${f}\0${this.hash(f)}`);
		return sha(h.join("\n"));
	}

	/** Branch the main checkout has out (the queue's integration branch), or config.base. */
	baseRef() {
		if (this.config.base) return this.config.base;
		const b = git(this.main, ["symbolic-ref", "--short", "-q", "HEAD"]);
		return b.ok && b.out.trim() ? b.out.trim() : "HEAD";
	}

	/** Files changed vs the merge base with the base branch, plus uncommitted and untracked ones. */
	changedFiles(baseRef = this.baseRef()) {
		const mb = git(this.abs, ["merge-base", "HEAD", baseRef]);
		const from = mb.ok ? mb.out.trim() : "HEAD";
		const d = git(this.abs, ["diff", "--name-only", "-z", from]);
		const u = git(this.abs, ["ls-files", "-o", "--exclude-standard", "-z"]);
		const out = new Set();
		for (const f of `${d.out}\0${u.out}`.split("\0")) if (f && !ALWAYS_SKIP.some((s) => f.startsWith(s))) out.add(f);
		return out;
	}

	/** Uncommitted changes only (vs HEAD). */
	dirtyFiles() {
		const d = git(this.abs, ["diff", "--name-only", "-z", "HEAD"]);
		const u = git(this.abs, ["ls-files", "-o", "--exclude-standard", "-z"]);
		return new Set(`${d.out}\0${u.out}`.split("\0").filter((f) => f && !ALWAYS_SKIP.some((s) => f.startsWith(s))));
	}

	head() {
		const h = git(this.abs, ["rev-parse", "HEAD"]);
		return h.ok ? h.out.trim() : "";
	}
}

export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock", "go.work", "go.work.sum", "uv.lock", "poetry.lock", "Pipfile.lock"];

export function rootLockfiles(rc) {
	return LOCKFILES.filter((f) => rc.has(f));
}

export function exists(rc, r) {
	return rc.has(r) || existsSync(rc.path(r));
}
