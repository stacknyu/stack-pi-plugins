// TypeScript / JavaScript: typecheck (tsc / vue-tsc) per project, lint (eslint / oxlint) per file,
// tests (vitest / jest) per test file. Inputs come from a static import graph.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kindOptions, rootLockfiles } from "../repo.mjs";
import { cleanEnv, baseOf, dirOf, findBin, isUnder, joinRel, loadJsonc, matchAny, normRel, parseDuration, parseJsonc, runProc, sha } from "../util.mjs";

const SRC_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const LINT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;
const TEST_FILE = /(\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$)|(\/__tests__\/.+\.(ts|tsx|js|jsx|mjs|cjs)$)/;
const DEFAULT_TEST_EXCLUDE = ["**/e2e/**", "**/playwright/**", "**/*.e2e.*", "**/cypress/**", "**/node_modules/**", "**/dist/**"];
/** Drop runner-internal stack frames and shorten paths, so the failure itself is what the agent reads. */
function trimStack(text, root) {
	return String(text ?? "")
		.split("\n")
		.filter((l) => !/node_modules\/|node:internal|\(internal\//.test(l))
		.join("\n")
		.split(`${root}/`)
		.join("");
}
const isSrc = (f) => SRC_EXT.some((e) => f.endsWith(e)) || f.endsWith(".json") || f.endsWith(".css") || f.endsWith(".scss");

function readPkg(rc, dir) {
	const t = rc.text(joinRel(dir, "package.json"));
	try {
		return JSON.parse(t);
	} catch {
		return undefined;
	}
}

/** tsconfig chain (local files only) and merged compilerOptions. */
function tsconfigInfo(rc, file) {
	const chain = [];
	let opts = {};
	let raw;
	let cur = file;
	for (let i = 0; i < 8 && cur && rc.has(cur); i++) {
		const j = parseJsonc(rc.text(cur)) ?? {};
		if (i === 0) raw = j;
		chain.push(cur);
		const co = j.compilerOptions ?? {};
		// earlier (child) options win; record the dir that defined paths/baseUrl
		const merged = { ...co, ...opts };
		if (co.paths && !opts.paths) merged.__pathsDir = dirOf(cur);
		if (co.baseUrl && !opts.baseUrl) merged.__baseDir = dirOf(cur);
		opts = merged;
		const ext = Array.isArray(j.extends) ? j.extends[0] : j.extends;
		if (!ext || !ext.startsWith(".")) break;
		let next = normRel(joinRel(dirOf(cur), ext));
		if (!next.endsWith(".json")) next += ".json";
		cur = next;
	}
	return { chain, opts, raw: raw ?? {} };
}

function importSpecs(text) {
	const out = new Set();
	let dynamicGlob = false;
	for (const re of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /\b(?:vi|jest)\.(?:mock|requireActual|importActual)\(\s*["']([^"']+)["']/g, /@import\s+(?:url\()?["']([^"']+)["']/g]) {
		for (const m of text.matchAll(re)) out.add(m[1]);
	}
	if (/import\.meta\.glob|require\.context/.test(text)) dynamicGlob = true;
	return { specs: [...out], dynamicGlob };
}

function workspace(rc) {
	let w = rc.memo.get("ts:ws");
	if (w) return w;
	const byName = new Map();
	const dirs = [];
	for (const f of rc.listing().files) {
		if (baseOf(f) !== "package.json") continue;
		const d = dirOf(f);
		dirs.push(d);
		const pj = readPkg(rc, d);
		if (pj?.name) byName.set(pj.name, d);
	}
	w = { byName, dirs };
	rc.memo.set("ts:ws", w);
	return w;
}

/** Files that belong to a project dir, excluding nested package dirs. */
function projectFiles(rc, dir) {
	const key = `ts:files:${dir}`;
	let v = rc.memo.get(key);
	if (v) return v;
	const nested = workspace(rc).dirs.filter((d) => d !== dir && isUnder(d, dir));
	v = rc.filesUnder(dir).filter((f) => !nested.some((n) => isUnder(f, n)));
	rc.memo.set(key, v);
	return v;
}

class Resolver {
	constructor(rc, project) {
		this.rc = rc;
		this.project = project;
		const tsc = tsconfigInfo(rc, joinRel(project.dir, "tsconfig.json"));
		this.tsconfigChain = tsc.chain;
		this.paths = tsc.opts.paths ?? {};
		this.pathsDir = tsc.opts.__pathsDir ?? project.dir;
		this.baseDir = tsc.opts.baseUrl ? normRel(joinRel(tsc.opts.__baseDir ?? project.dir, tsc.opts.baseUrl)) : undefined;
		if (tsc.opts.baseUrl && tsc.opts.paths) this.pathsDir = this.baseDir;
		this.ws = workspace(rc);
	}
	tryFile(p) {
		const rc = this.rc;
		p = normRel(p);
		if (rc.has(p)) return p;
		for (const e of SRC_EXT) if (rc.has(p + e)) return p + e;
		const js = p.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
		if (js) for (const e of [".ts", ".tsx", ".mts", ".cts"]) if (rc.has(js[1] + e)) return js[1] + e;
		for (const e of SRC_EXT) if (rc.has(`${p}/index${e}`)) return `${p}/index${e}`;
		return undefined;
	}
	/** -> { file } | { pkgDir } | { unknownLocal: true } | undefined (external) */
	resolve(from, spec) {
		spec = spec.split("?")[0];
		if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
			const f = this.tryFile(joinRel(dirOf(from), spec));
			return f ? { file: f } : undefined;
		}
		if (spec.startsWith("/")) return undefined;
		for (const [pat, targets] of Object.entries(this.paths)) {
			const star = pat.indexOf("*");
			let rest;
			if (star < 0) {
				if (spec !== pat) continue;
				rest = "";
			} else {
				const pre = pat.slice(0, star);
				const post = pat.slice(star + 1);
				if (!spec.startsWith(pre) || !spec.endsWith(post) || spec.length < pre.length + post.length) continue;
				rest = spec.slice(pre.length, spec.length - post.length);
			}
			for (const t of targets ?? []) {
				const f = this.tryFile(joinRel(this.pathsDir, t.replace("*", rest)));
				if (f) return { file: f };
			}
		}
		const parts = spec.split("/");
		const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
		const pkgDir = this.ws.byName.get(name);
		if (pkgDir !== undefined) return { pkgDir };
		if (this.baseDir) {
			const f = this.tryFile(joinRel(this.baseDir, spec));
			if (f) return { file: f };
		}
		if (/^(@\/|~\/|#|\$)/.test(spec) || spec.startsWith("@/")) return { unknownLocal: true };
		return undefined;
	}
	/** Import closure of the given files (repo-relative). */
	closure(files) {
		const rc = this.rc;
		const seen = new Set();
		const pkgs = new Set();
		let conservative = false;
		const stack = [...files];
		while (stack.length) {
			const f = stack.pop();
			if (seen.has(f)) continue;
			seen.add(f);
			if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|css|scss)$/.test(f)) continue;
			const mk = `ts:imp:${rc.hash(f)}`;
			let parsed = rc.hasher.memo.get(mk);
			if (!parsed) {
				parsed = importSpecs(rc.text(f));
				rc.hasher.memo.set(mk, parsed);
			}
			if (parsed.dynamicGlob) conservative = true;
			for (const s of parsed.specs) {
				const r = this.resolve(f, s);
				if (!r) continue;
				if (r.file) stack.push(r.file);
				else if (r.pkgDir !== undefined) pkgs.add(r.pkgDir);
				else if (r.unknownLocal) conservative = true;
			}
		}
		const out = new Set(seen);
		for (const d of pkgs) for (const f of projectFiles(rc, d)) if (isSrc(f) || baseOf(f) === "package.json") out.add(f);
		if (conservative) for (const f of projectFiles(rc, this.project.dir)) if (isSrc(f)) out.add(f);
		return out;
	}
}

function resolver(rc, project) {
	const k = `ts:res:${project.dir}`;
	let r = rc.memo.get(k);
	if (!r) rc.memo.set(k, (r = new Resolver(rc, project)));
	return r;
}

function wsDepsClosure(rc, dir) {
	const ws = workspace(rc);
	const out = new Set();
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		const pj = readPkg(rc, d) ?? {};
		for (const name of Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies })) {
			const dd = ws.byName.get(name);
			if (dd !== undefined && dd !== dir && !out.has(dd)) {
				out.add(dd);
				stack.push(dd);
			}
		}
	}
	return [...out];
}

function binFor(rc, project, name) {
	const abs = rc.path(project.dir);
	const mainAbs = project.dir === "." ? rc.main : join(rc.main, project.dir);
	return findBin(name, abs, rc.abs, [mainAbs, rc.main]);
}

function common(rc, project) {
	const out = [joinRel(project.dir, "package.json"), ...rootLockfiles(rc)];
	if (project.dir !== "." && rc.has("package.json")) out.push("package.json");
	return out;
}

const adapter = {
	lang: "ts",
	version: 1,

	detect(rc) {
		if (!rc.config.languages.ts) return [];
		const ws = workspace(rc);
		const out = [];
		for (const d of ws.dirs.sort()) {
			const pj = readPkg(rc, d);
			if (!pj) continue;
			const deps = { ...pj.dependencies, ...pj.devDependencies };
			const scripts = pj.scripts ?? {};
			const files = projectFiles(rc, d);
			const local = new Set(files.filter((f) => dirOf(f) === d).map(baseOf));
			const kinds = [];
			const meta = {};
			if (local.has("tsconfig.json")) {
				const tc = parseJsonc(rc.text(joinRel(d, "tsconfig.json"))) ?? {};
				const solutionOnly = Array.isArray(tc.files) && tc.files.length === 0 && tc.references;
				if (!solutionOnly && files.some((f) => /\.(ts|tsx|mts|cts|vue)$/.test(f))) {
					kinds.push("typecheck");
					meta.tsc = deps["vue-tsc"] || deps.vue ? "vue-tsc" : "tsc";
					meta.composite = !!tc.compilerOptions?.composite;
				}
			}
			const lintScript = `${scripts.lint ?? ""}`;
			const hasEslintCfg = [...local].some((f) => /^(eslint\.config\.(js|mjs|cjs|ts|mts)|\.eslintrc(\.(js|cjs|json|yml|yaml))?)$/.test(f));
			const hasOxCfg = local.has(".oxlintrc.json") || local.has("oxlintrc.json") || local.has("oxlint.config.ts");
			if (/oxlint/.test(lintScript) || ((deps.oxlint || hasOxCfg) && !/eslint/.test(lintScript))) meta.linter = "oxlint";
			else if (/eslint/.test(lintScript) || deps.eslint || hasEslintCfg) meta.linter = "eslint";
			if (meta.linter && files.some((f) => LINT_EXT.test(f))) kinds.push("lint");
			const testScript = `${scripts.test ?? ""}`;
			if (deps.vitest || /vitest/.test(testScript) || [...local].some((f) => /^vitest\.(config|workspace)\./.test(f))) meta.tester = "vitest";
			else if (deps.jest || /\bjest\b/.test(testScript) || [...local].some((f) => /^jest\.config\./.test(f))) meta.tester = "jest";
			if (meta.tester && files.some((f) => TEST_FILE.test(f))) kinds.push("test");
			const enabled = kinds.filter((k) => kindOptions(rc.config, d, k) !== false);
			if (enabled.length) out.push({ id: `ts:${d}`, lang: "ts", dir: d, name: pj.name ?? d, kinds: enabled, meta });
		}
		return out;
	},

	units(rc, project, kind) {
		const opts = kindOptions(rc.config, project.dir, kind) || {};
		const files = projectFiles(rc, project.dir);
		const rel = (f) => (project.dir === "." ? f : f.slice(project.dir.length + 1));
		const extra = (opts.inputs ?? []).length ? files.filter((f) => matchAny(opts.inputs, rel(f))) : [];
		const res = resolver(rc, project);
		const base = [...common(rc, project), ...res.tsconfigChain, ...extra];
		if (kind === "typecheck") {
			const inputs = [...base, ...files.filter((f) => isSrc(f) && !f.endsWith("package-lock.json"))];
			for (const d of wsDepsClosure(rc, project.dir)) inputs.push(...projectFiles(rc, d).filter((f) => isSrc(f) || baseOf(f) === "package.json"));
			return [{ target: project.dir, label: `${project.name} typecheck`, inputs }];
		}
		if (kind === "lint") {
			const cfg = files.filter((f) => dirOf(f) === project.dir && /^(eslint\.config\.|\.eslintrc|\.oxlintrc|oxlintrc|oxlint\.config|\.eslintignore)/.test(baseOf(f)));
			if (project.dir !== ".") for (const f of rc.listing().files) if (dirOf(f) === "." && /^(eslint\.config\.|\.eslintrc|\.oxlintrc|\.eslintignore)/.test(baseOf(f))) cfg.push(f);
			const exclude = opts.exclude ?? [];
			return files.filter((f) => LINT_EXT.test(f) && !matchAny(exclude, rel(f))).map((f) => ({ target: f, label: f, inputs: [f, ...cfg, ...base] }));
		}
		if (kind === "test") {
			const exclude = [...DEFAULT_TEST_EXCLUDE, ...(opts.exclude ?? [])];
			const tests = files.filter((f) => TEST_FILE.test(f) && !matchAny(exclude, rel(f)) && !matchAny(exclude, f));
			const cfgFiles = files.filter((f) => dirOf(f) === project.dir && (/\.config\.(c|m)?(j|t)s$/.test(f) || /^\.env/.test(baseOf(f)) || /^(babel|\.babelrc)/.test(baseOf(f))));
			const setup = files.filter((f) => /setup/i.test(baseOf(f)) && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !TEST_FILE.test(f));
			const shared = [...base, ...res.closure([...cfgFiles, ...setup])];
			return tests.map((t) => ({ target: t, label: t, inputs: [...shared, ...res.closure([t])] }));
		}
		return [];
	},

	group(project, kind, opts) {
		return { name: `ts:${project.dir}:${kind}`, limit: opts?.parallel ?? (kind === "lint" ? 2 : 1) };
	},

	batchSize: (kind) => (kind === "lint" ? 400 : kind === "test" ? 80 : 1),

	argsKey(opts, project) {
		return JSON.stringify({ args: opts?.args ?? [], env: opts?.env ?? {}, cmd: opts?.cmd ?? "", tool: project.meta });
	},

	async run({ rc, project, kind, units, opts, threads, signal, nice, tmpDir }) {
		const cwd = rc.path(project.dir);
		const env = cleanEnv({ CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...(opts?.env ?? {}) });
				const results = new Map();
		const relFromProject = (f) => (project.dir === "." ? f : f.slice(project.dir.length + 1));
		const toRepo = (p) => {
			// p: absolute or relative to cwd
			const abs = p.startsWith("/") ? p : join(cwd, p);
			if (abs.startsWith(`${rc.abs}/`)) return normRel(abs.slice(rc.abs.length + 1));
			return normRel(joinRel(project.dir, p));
		};
		const timeoutMs = parseDuration(opts?.timeout, 20 * 60000);
		const fail = (u, failures, output = "") => results.set(u.target, { status: "fail", failures, output });
		const errAll = (title, text) => {
			for (const u of units) results.set(u.target, { status: "error", failures: [{ id: `${u.target}::[error]`, title, output: String(text).slice(-6000) }], output: String(text).slice(-6000) });
		};

		if (kind === "typecheck") {
			const u = units[0];
			let cmd;
			let args;
			if (opts?.cmd) {
				cmd = "/bin/sh";
				args = ["-c", opts.cmd];
			} else {
				cmd = binFor(rc, project, project.meta.tsc ?? "tsc");
				if (!cmd) return errAll(`${project.meta.tsc ?? "tsc"} not found (install dependencies)`, ""), { results, ms: 0 };
				args = ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"];
				if (!project.meta.composite) {
					mkdirSync(tmpDir, { recursive: true });
					args.push("--incremental", "--tsBuildInfoFile", join(tmpDir, `tsc-${sha(rc.abs + project.dir).slice(0, 12)}.tsbuildinfo`));
				}
				args.push(...(opts?.args ?? []));
			}
			const r = await runProc({ cmd, args, cwd, env, signal, nice, timeoutMs });
			const errs = [];
			for (const line of `${r.stdout}\n${r.stderr}`.split("\n")) {
				const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
				if (m) errs.push({ file: toRepo(m[1]), line: Number(m[2]), code: m[4], msg: m[5] });
				else {
					const g = line.match(/^error (TS\d+): (.*)$/);
					if (g) errs.push({ file: "", line: 0, code: g[1], msg: g[2] });
					else if (/^\s{2,}\S/.test(line) && errs.length) errs[errs.length - 1].msg += ` ${line.trim()}`;
				}
			}
			if (errs.length) fail(u, errs.map((e) => ({ id: `${e.file}:${e.code}:${e.msg}`, title: `${e.file}${e.line ? `:${e.line}` : ""} ${e.code} ${e.msg}`, output: "" })), `${r.stdout}`.slice(-20000));
			else if (r.code !== 0) results.set(u.target, { status: r.killed ? "error" : "fail", failures: [{ id: `${project.dir}:typecheck:[error]`, title: "typecheck exited with an error", output: `${r.stdout}\n${r.stderr}`.trim().slice(-6000) }], output: "" });
			else results.set(u.target, { status: "pass", failures: [], passed: 1, output: "" });
			return { results, ms: r.ms, killed: r.killed };
		}

		if (kind === "lint") {
			const linter = project.meta.linter;
			const bin = binFor(rc, project, linter);
			if (!bin) return errAll(`${linter} not found (install dependencies)`, ""), { results, ms: 0 };
			const files = units.map((u) => relFromProject(u.target));
			const args = linter === "eslint" ? ["--format", "json", ...(opts?.args ?? []), ...files] : ["--format", "json", ...(opts?.args ?? []), ...files];
			const r = await runProc({ cmd: bin, args, cwd, env, signal, nice, timeoutMs });
			const per = new Map(units.map((u) => [u.target, []]));
			let parsed = false;
			const text = r.stdout;
			if (linter === "eslint") {
				const start = text.indexOf("[");
				try {
					const arr = JSON.parse(text.slice(start));
					parsed = true;
					for (const f of arr) {
						const file = toRepo(f.filePath);
						for (const m of f.messages ?? []) if (m.severity === 2 || m.fatal) per.get(file)?.push({ rule: m.ruleId ?? "fatal", msg: m.message, line: m.line ?? 0, file });
					}
				} catch {}
			} else {
				try {
					const j = JSON.parse(text.slice(text.indexOf("{") >= 0 && (text.indexOf("[") < 0 || text.indexOf("{") < text.indexOf("[")) ? text.indexOf("{") : text.indexOf("[")));
					parsed = true;
					const diags = Array.isArray(j) ? j : (j.diagnostics ?? []);
					for (const d of diags) {
						if (d.severity && !/error|deny/i.test(String(d.severity))) continue;
						const file = toRepo(d.filename ?? d.file ?? "");
						const line = d.labels?.[0]?.span?.line ?? d.line ?? 0;
						per.get(file)?.push({ rule: d.code ?? "", msg: d.message ?? "", line, file });
					}
				} catch {}
			}
			if (!parsed) {
				if (r.code === 0) for (const u of units) results.set(u.target, { status: "pass", failures: [], passed: 1, output: "" });
				else errAll(`${linter} output could not be read`, `${r.stdout}\n${r.stderr}`);
				return { results, ms: r.ms, killed: r.killed };
			}
			for (const u of units) {
				const d = per.get(u.target) ?? [];
				if (d.length) fail(u, d.map((x) => ({ id: `${x.file}:${x.rule}:${x.msg}`, title: `${x.file}:${x.line} ${x.rule} ${x.msg}`, output: "" })));
				else results.set(u.target, { status: "pass", failures: [], passed: 1, output: "" });
			}
			return { results, ms: r.ms, killed: r.killed };
		}

		if (kind === "test") {
			const tester = project.meta.tester;
			const bin = binFor(rc, project, tester);
			if (!bin) return errAll(`${tester} not found (install dependencies)`, ""), { results, ms: 0 };
			mkdirSync(tmpDir, { recursive: true });
			const outFile = join(tmpDir, `${tester}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
			const files = units.map((u) => relFromProject(u.target));
			const args = tester === "vitest" ? ["run", "--reporter=json", `--outputFile=${outFile}`, ...(opts?.args ?? []), ...files] : ["--json", `--outputFile=${outFile}`, "--runTestsByPath", `--maxWorkers=${threads}`, "--ci", ...(opts?.args ?? []), ...files];
			const r = await runProc({ cmd: bin, args, cwd, env, signal, nice, timeoutMs });
			let j;
			try {
				j = JSON.parse(readFileSync(outFile, "utf8"));
			} catch {}
			try {
				rmSync(outFile, { force: true });
			} catch {}
			if (!j) {
				errAll(r.killed ? `${tester} was stopped (timeout or cancelled)` : `${tester} produced no report`, `${r.stdout}\n${r.stderr}`);
				return { results, ms: r.ms, killed: r.killed };
			}
			const byFile = new Map();
			for (const tr of j.testResults ?? []) byFile.set(toRepo(tr.name), tr);
			for (const u of units) {
				const tr = byFile.get(u.target);
				if (!tr) {
					results.set(u.target, { status: "pass", failures: [], passed: 0, output: "", note: `not collected by ${tester} (excluded by its config)` });
					continue;
				}
				const as = tr.assertionResults ?? [];
				const failed = as.filter((a) => a.status === "failed");
				const passed = as.filter((a) => a.status === "passed").length;
				if (failed.length) fail(u, failed.map((a) => ({ id: `${u.target}::${a.fullName ?? a.title}`, title: `${u.target} › ${a.fullName ?? a.title}`, output: trimStack((a.failureMessages ?? []).join("\n"), rc.abs).slice(-6000) })));
				else if (tr.status === "failed") fail(u, [{ id: `${u.target}::[suite]`, title: `${u.target} failed to run`, output: String(tr.message ?? tr.failureMessage ?? "").slice(-6000) }]);
				else results.set(u.target, { status: "pass", failures: [], passed, output: "" });
				if (results.get(u.target)) results.get(u.target).passed = passed;
			}
			return { results, ms: r.ms, killed: r.killed };
		}
		return { results, ms: 0 };
	},
};

export default adapter;
export { importSpecs, Resolver, tsconfigInfo };
