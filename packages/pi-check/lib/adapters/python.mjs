// Python: pytest per test file (inputs = static import closure + conftest chain + config),
// ruff per file, mypy / pyright per project.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kindOptions, rootLockfiles } from "../repo.mjs";
import { cleanEnv, baseOf, dirOf, isUnder, joinRel, matchAny, normRel, parentDirs, parseDuration, runProc, which } from "../util.mjs";

const MARKERS = new Set(["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"]);
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const SKIP = /(^|\/)(\.venv|venv|env|site-packages|__pycache__|\.tox|node_modules|build|dist)(\/|$)/;
const CONFIG_FILES = ["pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", "tox.ini", "conftest.py", "requirements.txt", "requirements-dev.txt", "mypy.ini", ".mypy.ini", "ruff.toml", ".ruff.toml", "pyrightconfig.json"];

function dirsOfProjects(rc) {
	let v = rc.memo.get("py:dirs");
	if (v) return v;
	const dirs = new Set();
	for (const f of rc.listing().files) if (MARKERS.has(baseOf(f)) && !SKIP.test(f)) dirs.add(dirOf(f));
	v = [...dirs].sort();
	rc.memo.set("py:dirs", v);
	return v;
}

function projectFiles(rc, dir) {
	const k = `py:files:${dir}`;
	let v = rc.memo.get(k);
	if (v) return v;
	const nested = dirsOfProjects(rc).filter((d) => d !== dir && isUnder(d, dir));
	v = rc.filesUnder(dir).filter((f) => !SKIP.test(f) && !nested.some((n) => isUnder(f, n)));
	rc.memo.set(k, v);
	return v;
}

function parseImports(text) {
	const mods = [];
	for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w. \t,]+)/gm)) for (const part of m[1].split(",")) mods.push({ mod: part.trim().split(/\s+as\s+/)[0].trim(), names: [] });
	for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^\n#)]*)/gm)) mods.push({ mod: m[1], names: m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => s && s !== "*" && s !== "(") });
	return mods;
}

class PyResolver {
	constructor(rc, project) {
		this.rc = rc;
		this.project = project;
		const d = project.dir;
		this.roots = [d, joinRel(d, "src"), "."].filter((x, i, a) => a.indexOf(x) === i);
	}
	moduleFile(root, dotted) {
		const p = joinRel(root, dotted.split(".").join("/"));
		if (this.rc.has(`${p}.py`)) return `${p}.py`;
		if (this.rc.has(`${p}/__init__.py`)) return `${p}/__init__.py`;
		return undefined;
	}
	pkgInits(root, dotted) {
		const parts = dotted.split(".");
		const out = [];
		for (let i = 1; i < parts.length; i++) {
			const f = joinRel(root, `${parts.slice(0, i).join("/")}/__init__.py`);
			if (this.rc.has(f)) out.push(f);
		}
		return out;
	}
	resolve(from, { mod, names }) {
		const out = [];
		const roots = [dirOf(from), ...this.roots];
		let dotted = mod;
		let searchRoots = roots;
		if (mod.startsWith(".")) {
			const dots = mod.match(/^\.+/)[0].length;
			let base = dirOf(from);
			for (let i = 1; i < dots; i++) base = dirOf(base);
			dotted = mod.slice(dots);
			searchRoots = [base];
			if (!dotted) {
				for (const n of names) {
					const f = this.moduleFile(base, n);
					if (f) out.push(f);
				}
				const init = joinRel(base, "__init__.py");
				if (this.rc.has(init)) out.push(init);
				return out;
			}
		}
		for (const r of searchRoots) {
			const f = this.moduleFile(r, dotted);
			if (!f) continue;
			out.push(f, ...this.pkgInits(r, dotted));
			for (const n of names) {
				const sub = this.moduleFile(r, `${dotted}.${n}`);
				if (sub) out.push(sub);
			}
			break;
		}
		return out;
	}
	closure(files) {
		const seen = new Set();
		const stack = [...files];
		while (stack.length) {
			const f = stack.pop();
			if (seen.has(f)) continue;
			seen.add(f);
			if (!f.endsWith(".py")) continue;
			const mk = `py:imp:${this.rc.hash(f)}`;
			let parsed = this.rc.hasher.memo.get(mk);
			if (!parsed) {
				parsed = parseImports(this.rc.text(f));
				this.rc.hasher.memo.set(mk, parsed);
			}
			for (const imp of parsed) for (const g of this.resolve(f, imp)) if (!seen.has(g)) stack.push(g);
		}
		return seen;
	}
}

function hasSection(rc, file, re) {
	return rc.has(file) && re.test(rc.text(file));
}

function pythonCmd(rc, project) {
	const tries = [joinRel(project.dir, ".venv/bin/python"), joinRel(project.dir, "venv/bin/python"), ".venv/bin/python", "venv/bin/python"];
	for (const t of tries) {
		for (const base of [rc.abs, rc.main]) {
			const p = t === "." ? base : join(base, t);
			if (existsSync(p)) return [p];
		}
	}
	if ((rc.has(joinRel(project.dir, "uv.lock")) || rc.has("uv.lock")) && which("uv")) return [which("uv"), "run", "--no-sync", "python"];
	if ((rc.has(joinRel(project.dir, "poetry.lock")) || rc.has("poetry.lock")) && which("poetry")) return [which("poetry"), "run", "python"];
	return [which("python3") ?? which("python") ?? "python3"];
}

function toolBin(rc, project, name, py) {
	for (const base of [rc.path(project.dir), rc.abs, rc.main, join(rc.main, project.dir)]) for (const v of [".venv/bin", "venv/bin"]) if (existsSync(join(base, v, name))) return [join(base, v, name)];
	const onPath = which(name);
	if (onPath) return [onPath];
	return [...py, "-m", name];
}

function xmlUnescape(s) {
	return String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}

const adapter = {
	lang: "python",
	version: 1,

	detect(rc) {
		if (!rc.config.languages.python) return [];
		let dirs = dirsOfProjects(rc);
		if (!dirs.length && rc.listing().files.some((f) => TEST_FILE.test(f) && !SKIP.test(f))) dirs = ["."];
		const out = [];
		for (const d of dirs) {
			const files = projectFiles(rc, d);
			if (!files.some((f) => f.endsWith(".py"))) continue;
			const pyproject = joinRel(d, "pyproject.toml");
			const kinds = [];
			const meta = {};
			if (files.some((f) => TEST_FILE.test(f))) kinds.push("test");
			const ruffCfg = hasSection(rc, pyproject, /^\[tool\.ruff/m) || rc.has(joinRel(d, "ruff.toml")) || rc.has(joinRel(d, ".ruff.toml")) || rc.has("ruff.toml") || rc.has(".ruff.toml");
			if (ruffCfg) kinds.push("lint");
			if (hasSection(rc, pyproject, /^\[tool\.mypy\]/m) || rc.has(joinRel(d, "mypy.ini")) || rc.has(joinRel(d, ".mypy.ini")) || hasSection(rc, joinRel(d, "setup.cfg"), /^\[mypy\]/m)) {
				kinds.push("typecheck");
				meta.typechecker = "mypy";
				meta.mypyFiles = /^\s*files\s*=/m.test(rc.text(pyproject) + rc.text(joinRel(d, "mypy.ini")) + rc.text(joinRel(d, "setup.cfg")));
			} else if (hasSection(rc, pyproject, /^\[tool\.pyright\]/m) || rc.has(joinRel(d, "pyrightconfig.json"))) {
				kinds.push("typecheck");
				meta.typechecker = "pyright";
			}
			const enabled = kinds.filter((k) => kindOptions(rc.config, d, k) !== false);
			if (enabled.length) out.push({ id: `python:${d}`, lang: "python", dir: d, name: d === "." ? "python" : d, kinds: enabled, meta });
		}
		return out;
	},

	units(rc, project, kind) {
		const opts = kindOptions(rc.config, project.dir, kind) || {};
		const files = projectFiles(rc, project.dir);
		const rel = (f) => (project.dir === "." ? f : f.slice(project.dir.length + 1));
		const cfg = [...CONFIG_FILES.map((c) => joinRel(project.dir, c)).filter((c) => rc.has(c)), ...rootLockfiles(rc), ...CONFIG_FILES.filter((c) => project.dir !== "." && rc.has(c) && c !== "conftest.py")];
		const extra = (opts.inputs ?? []).length ? files.filter((f) => matchAny(opts.inputs, rel(f))) : [];
		if (kind === "typecheck") return [{ target: project.dir, label: `${project.name} typecheck`, inputs: [...cfg, ...extra, ...files.filter((f) => /\.(py|pyi)$/.test(f) || baseOf(f) === "py.typed")] }];
		if (kind === "lint") return files.filter((f) => f.endsWith(".py") && !matchAny(opts.exclude ?? [], rel(f))).map((f) => ({ target: f, label: f, inputs: [f, ...cfg] }));
		if (kind === "test") {
			const res = new PyResolver(rc, project);
			const tests = files.filter((f) => TEST_FILE.test(f) && !matchAny(opts.exclude ?? [], rel(f)));
			return tests.map((t) => {
				const conftests = parentDirs(t)
					.filter((d) => isUnder(d, project.dir) || d === ".")
					.map((d) => joinRel(d, "conftest.py"))
					.filter((c) => rc.has(c));
				return { target: t, label: t, inputs: [...cfg, ...extra, ...res.closure([t, ...conftests])] };
			});
		}
		return [];
	},

	group(project, kind, opts) {
		return { name: `python:${project.dir}:${kind}`, limit: opts?.parallel ?? (kind === "lint" ? 2 : 1) };
	},

	batchSize: (kind) => (kind === "lint" ? 400 : kind === "test" ? 80 : 1),

	argsKey(opts, project) {
		return JSON.stringify({ args: opts?.args ?? [], env: opts?.env ?? {}, cmd: opts?.cmd ?? "", tool: project.meta });
	},

	async run({ rc, project, kind, units, opts, signal, nice, tmpDir }) {
		const cwd = rc.path(project.dir);
		const env = cleanEnv({ PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", ...(opts?.env ?? {}) });
				const py = pythonCmd(rc, project);
		const results = new Map();
		const timeoutMs = parseDuration(opts?.timeout, 20 * 60000);
		const toRepo = (p) => {
			const abs = p.startsWith("/") ? p : join(cwd, p);
			return abs.startsWith(`${rc.abs}/`) ? normRel(abs.slice(rc.abs.length + 1)) : normRel(joinRel(project.dir, p));
		};
		const errAll = (title, text) => {
			for (const u of units) results.set(u.target, { status: "error", failures: [{ id: `${u.target}::[error]`, title, output: String(text).slice(-6000) }], output: "" });
		};
		const relFromProject = (f) => (project.dir === "." ? f : f.slice(project.dir.length + 1));

		if (kind === "test") {
			mkdirSync(tmpDir, { recursive: true });
			const xml = join(tmpDir, `pytest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`);
			// a project venv's python first; otherwise a pytest on PATH (it knows its own interpreter)
			const runner = py[0].includes("/.venv/") || py[0].includes("/venv/") || py.length > 1 || !which("pytest") ? [...py, "-m", "pytest"] : [which("pytest")];
			const args = [...runner.slice(1), "-q", "-p", "no:cacheprovider", "-o", "junit_family=xunit1", `--junitxml=${xml}`, ...(opts?.args ?? []), ...units.map((u) => relFromProject(u.target))];
			const r = await runProc({ cmd: runner[0], args, cwd, env, signal, nice, timeoutMs });
			let text = "";
			try {
				text = readFileSync(xml, "utf8");
				rmSync(xml, { force: true });
			} catch {}
			if (!text) {
				if (r.code === 5) for (const u of units) results.set(u.target, { status: "pass", failures: [], passed: 0, output: "", note: "no tests collected" });
				else errAll(r.killed ? "pytest was stopped (timeout or cancelled)" : /No module named pytest/.test(r.stderr + r.stdout) ? "pytest is not installed for this project's Python" : "pytest produced no report", `${r.stdout}\n${r.stderr}`);
				return { results, ms: r.ms, killed: r.killed };
			}
			const per = new Map(units.map((u) => [u.target, { passed: 0, failures: [] }]));
			const byModule = new Map(units.map((u) => [relFromProject(u.target).replace(/\.py$/, "").split("/").join("."), u.target]));
			for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
				const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], xmlUnescape(a[2])]));
				let target;
				if (attrs.file) {
					const f = toRepo(attrs.file);
					target = per.has(f) ? f : [...per.keys()].find((k) => k.endsWith(attrs.file));
				}
				if (!target) {
					const cls = attrs.classname || attrs.name || "";
					for (const [mod, t] of byModule) if (cls === mod || cls.startsWith(`${mod}.`) || mod.endsWith(cls)) target = t;
				}
				if (!target) continue;
				const body = m[2] ?? "";
				const bad = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
				const x = per.get(target);
				if (bad) {
					const msg = xmlUnescape((bad[2].match(/message="([^"]*)"/) ?? [])[1] ?? "");
					const cls = (attrs.classname ?? "").split(".").pop();
					const name = attrs.name ? `${cls && cls !== baseOf(target).replace(/\.py$/, "") ? `${cls}::` : ""}${attrs.name}` : "[collection]";
					x.failures.push({ id: `${target}::${name}`, title: `${target}::${name}${bad[1] === "error" ? " (error)" : ""}`, output: `${msg}\n${xmlUnescape(bad[3] ?? "")}`.trim().slice(-6000) });
				} else if (!/<skipped/.test(body)) x.passed++;
			}
			for (const u of units) {
				const x = per.get(u.target);
				results.set(u.target, x.failures.length ? { status: "fail", failures: x.failures, passed: x.passed, output: "" } : { status: "pass", failures: [], passed: x.passed, output: "" });
			}
			return { results, ms: r.ms, killed: r.killed };
		}

		if (kind === "lint") {
			const ruff = toolBin(rc, project, "ruff", py);
			const r = await runProc({ cmd: ruff[0], args: [...ruff.slice(1), "check", "--output-format", "json", ...(opts?.args ?? []), ...units.map((u) => relFromProject(u.target))], cwd, env, signal, nice, timeoutMs });
			let arr;
			try {
				arr = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
			} catch {}
			if (!arr) {
				errAll("ruff output could not be read", `${r.stdout}\n${r.stderr}`);
				return { results, ms: r.ms, killed: r.killed };
			}
			const per = new Map(units.map((u) => [u.target, []]));
			for (const d of arr) per.get(toRepo(d.filename))?.push(d);
			for (const u of units) {
				const d = per.get(u.target);
				results.set(u.target, d.length ? { status: "fail", failures: d.map((x) => ({ id: `${u.target}:${x.code}:${x.message}`, title: `${u.target}:${x.location?.row ?? 0} ${x.code} ${x.message}`, output: "" })), output: "" } : { status: "pass", failures: [], passed: 1, output: "" });
			}
			return { results, ms: r.ms, killed: r.killed };
		}

		if (kind === "typecheck") {
			const u = units[0];
			let r;
			const errs = [];
			if (project.meta.typechecker === "pyright") {
				const bin = toolBin(rc, project, "pyright", py);
				r = await runProc({ cmd: bin[0], args: [...bin.slice(1), "--outputjson", ...(opts?.args ?? [])], cwd, env, signal, nice, timeoutMs });
				try {
					const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
					for (const d of j.generalDiagnostics ?? []) if (d.severity === "error") errs.push({ file: toRepo(d.file ?? ""), line: (d.range?.start?.line ?? 0) + 1, code: d.rule ?? "", msg: d.message });
				} catch {}
			} else {
				const args = [...py.slice(1), "-m", "mypy", "--no-color-output", "--no-error-summary", "--show-error-codes", "--hide-error-context", ...(opts?.args ?? [])];
				if (!project.meta.mypyFiles && !(opts?.args ?? []).length) args.push(".");
				r = await runProc({ cmd: py[0], args, cwd, env, signal, nice, timeoutMs });
				for (const line of r.stdout.split("\n")) {
					const m = line.match(/^(.+?):(\d+):(?:\d+:)?\s*error:\s*(.*?)(?:\s+\[([\w-]+)\])?$/);
					if (m) errs.push({ file: toRepo(m[1]), line: Number(m[2]), code: m[4] ?? "", msg: m[3] });
				}
			}
			if (errs.length) results.set(u.target, { status: "fail", failures: errs.map((e) => ({ id: `${e.file}:${e.code}:${e.msg}`, title: `${e.file}:${e.line} ${e.code} ${e.msg}`, output: "" })), output: r.stdout.slice(-20000) });
			else if (r.code !== 0) results.set(u.target, { status: "error", failures: [{ id: `${project.dir}:typecheck:[error]`, title: `${project.meta.typechecker} exited with an error`, output: `${r.stdout}\n${r.stderr}`.trim().slice(-6000) }], output: "" });
			else results.set(u.target, { status: "pass", failures: [], passed: 1, output: "" });
			return { results, ms: r.ms, killed: r.killed };
		}
		return { results, ms: 0 };
	},
};

export default adapter;
export { parseImports, PyResolver };
