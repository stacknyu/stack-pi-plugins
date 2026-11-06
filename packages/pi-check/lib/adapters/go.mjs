// Go: one unit per package. Inputs = the package's files plus every in-repo package it (and its tests) import.
import { join } from "node:path";
import { kindOptions, rootLockfiles } from "../repo.mjs";
import { SHIM_DIR, cleanEnv, baseOf, dirOf, isUnder, joinRel, matchGlob, normRel, parseDuration, runProc, which } from "../util.mjs";

const SKIP_SEG = /(^|\/)(vendor|testdata|node_modules|_[^/]*|\.[^/]+)(\/|$)/;

function goHeader(text) {
	const cut = text.search(/^(func|type|var|const)\b/m);
	return cut > 0 ? text.slice(0, cut) : text;
}

function parseGoFile(text) {
	const head = goHeader(text);
	const imports = [];
	const re = /^\s*import\s*(?:\(([\s\S]*?)\)|(?:[\w.]+\s+)?"([^"]+)")/gm;
	let m;
	while ((m = re.exec(head))) {
		if (m[2]) imports.push(m[2]);
		else if (m[1]) for (const mm of m[1].matchAll(/"([^"]+)"/g)) imports.push(mm[1]);
	}
	const embeds = [];
	for (const em of text.matchAll(/^\s*\/\/go:embed\s+(.+)$/gm)) for (const p of em[1].trim().split(/\s+/)) embeds.push(p.replace(/^"|"$/g, "").replace(/^all:/, ""));
	return { imports, embeds };
}

/** Modules, packages and the import graph of a checkout (memoized per checkout version). */
export function goGraph(rc) {
	const cached = rc.memo.get("go:graph");
	if (cached) return cached;
	const files = rc.listing().files;
	const modules = [];
	for (const f of files) {
		if (baseOf(f) !== "go.mod" || SKIP_SEG.test(dirOf(f) === "." ? "" : dirOf(f))) continue;
		const m = rc.text(f).match(/^\s*module\s+(\S+)/m);
		if (m) modules.push({ dir: dirOf(f), path: m[1].replace(/"/g, "") });
	}
	modules.sort((a, b) => b.dir.length - a.dir.length);
	const moduleOf = (dir) => modules.find((m) => isUnder(dir, m.dir));
	const pkgs = new Map(); // dir -> pkg
	const byDir = new Map(); // dir -> all files directly in dir
	for (const f of files) {
		const d = dirOf(f);
		if (!byDir.has(d)) byDir.set(d, []);
		byDir.get(d).push(f);
	}
	for (const f of files) {
		if (!f.endsWith(".go")) continue;
		const d = dirOf(f);
		if (SKIP_SEG.test(d === "." ? "" : d)) continue;
		const mod = moduleOf(d);
		if (!mod) continue;
		let p = pkgs.get(d);
		if (!p) {
			const relInMod = d === mod.dir ? "" : mod.dir === "." ? d : d.slice(mod.dir.length + 1);
			p = { dir: d, module: mod, importPath: relInMod ? `${mod.path}/${relInMod}` : mod.path, rel: relInMod ? `./${relInMod}` : ".", goFiles: [], imports: new Set(), testImports: new Set(), embeds: [], hasTests: false };
			pkgs.set(d, p);
		}
		p.goFiles.push(f);
		const memoKey = `go:file:${rc.hash(f)}`;
		let parsed = rc.hasher.memo.get(memoKey);
		if (!parsed) {
			parsed = parseGoFile(rc.text(f));
			rc.hasher.memo.set(memoKey, parsed);
		}
		const isTest = f.endsWith("_test.go");
		if (isTest) p.hasTests = true;
		for (const i of parsed.imports) (isTest ? p.testImports : p.imports).add(i);
		for (const e of parsed.embeds) p.embeds.push(e);
	}
	const byImport = new Map();
	for (const p of pkgs.values()) byImport.set(p.importPath, p);
	// embed + testdata files per package
	for (const p of pkgs.values()) {
		const extra = [];
		for (const f of files) {
			if (!isUnder(f, p.dir)) continue;
			const r = p.dir === "." ? f : f.slice(p.dir.length + 1);
			if (r.startsWith("testdata/")) extra.push(f);
			else if (p.embeds.some((e) => r === e || r.startsWith(`${e.replace(/\/$/, "")}/`) || matchGlob(e, r))) extra.push(f);
		}
		p.extra = extra;
		p.dirFiles = byDir.get(p.dir) ?? [];
	}
	const g = { modules, pkgs, byImport, depMemo: new Map() };
	rc.memo.set("go:graph", g);
	return g;
}

function deps(g, p) {
	// transitive in-repo non-test imports
	let s = g.depMemo.get(p.dir);
	if (s) return s;
	s = new Set();
	g.depMemo.set(p.dir, s);
	for (const i of p.imports) {
		const q = g.byImport.get(i);
		if (!q || s.has(q.dir)) continue;
		s.add(q.dir);
		for (const d of deps(g, q)) s.add(d);
	}
	return s;
}

function closure(g, p) {
	const s = new Set([p.dir, ...deps(g, p)]);
	for (const i of p.testImports) {
		const q = g.byImport.get(i);
		if (!q) continue;
		s.add(q.dir);
		for (const d of deps(g, q)) s.add(d);
	}
	return s;
}

const adapter = {
	lang: "go",
	version: 2,

	detect(rc) {
		if (!rc.config.languages.go) return [];
		const g = goGraph(rc);
		return [...g.modules]
			.sort((a, b) => a.dir.localeCompare(b.dir))
			.map((m) => ({ id: `go:${m.dir}`, lang: "go", dir: m.dir, name: m.path, kinds: ["vet", "test"].filter((k) => kindOptions(rc.config, m.dir, k) !== false) }));
	},

	units(rc, project, kind) {
		const g = goGraph(rc);
		const opts = kindOptions(rc.config, project.dir, kind) || {};
		const extraGlobs = opts.inputs ?? [];
		const extraFiles = extraGlobs.length ? rc.filesUnder(project.dir).filter((f) => extraGlobs.some((gl) => matchGlob(gl, project.dir === "." ? f : f.slice(project.dir.length + 1)))) : [];
		const roots = [...rootLockfiles(rc)];
		const out = [];
		for (const p of g.pkgs.values()) {
			if (p.module.dir !== project.dir) continue;
			if (kind === "test" && !p.hasTests) continue;
			const inputs = [...p.dirFiles, ...p.extra, ...extraFiles, ...roots];
			const mods = new Set([p.module]);
			for (const d of closure(g, p)) {
				const q = g.pkgs.get(d);
				if (!q) continue;
				mods.add(q.module);
				if (q === p) continue;
				inputs.push(...q.goFiles.filter((f) => !f.endsWith("_test.go")), ...q.extra.filter((f) => !f.includes("/testdata/") && !f.startsWith("testdata/")));
			}
			for (const m of mods) for (const f of ["go.mod", "go.sum"]) if (rc.has(joinRel(m.dir, f))) inputs.push(joinRel(m.dir, f));
			out.push({ target: p.dir, label: p.importPath, inputs });
		}
		return out;
	},

	group(project, kind, opts) {
		// A project can opt into serialization for shared ports/databases. Otherwise the
		// broker budgets package processes globally, independently of agent count.
		return { name: `go:${project.dir}:${kind}`, limit: opts?.parallel ?? Infinity };
	},

	batchSize: () => 1,

	/** Args that change results (part of the cache key). */
	argsKey(opts) {
		return JSON.stringify({ args: opts?.args ?? [], env: opts?.env ?? {}, timeout: opts?.timeout ?? "10m" });
	},

	async run({ rc, project, kind, units, opts, threads, signal, nice, extraArgs = [], onUnit, onProgress }) {
		const g = goGraph(rc);
		const goBin = which("go", { skipDir: SHIM_DIR }) ?? "go";
		const cwd = rc.path(project.dir);
		const pkgs = units.map((u) => g.pkgs.get(u.target)).filter(Boolean);
		const env = cleanEnv({ GOMAXPROCS: String(threads), GOFLAGS: `${process.env.GOFLAGS ?? ""} -p=${threads}`.trim(), ...(opts?.env ?? {}) });
		const results = new Map();
		if (kind === "vet") {
			const r = await runProc({ cmd: goBin, args: ["vet", ...(opts?.args ?? []), ...extraArgs, ...pkgs.map((p) => p.rel)], cwd, env, signal, nice, timeoutMs: parseDuration(opts?.timeout, 15 * 60000) });
			const diags = new Map();
			let header;
			for (const raw of `${r.stdout}\n${r.stderr}`.split("\n")) {
				const line = raw.replace(/^vet: /, "");
				const h = line.match(/^# (\S+)/);
				if (h) {
					header = g.byImport.get(h[1]);
					continue;
				}
				const m = line.match(/^(?:\.\/)?([^:\s][^:]*\.go):(\d+):(?:(\d+):)?\s*(.*)$/);
				if (!m) {
					if (header && line.trim()) (diags.get(header.dir) ?? diags.set(header.dir, []).get(header.dir)).push({ file: "", msg: line.trim(), line: 0 });
					continue;
				}
				const file = normRel(joinRel(project.dir, m[1]));
				const owner = g.pkgs.get(dirOf(file)) ?? header;
				if (!owner) continue;
				(diags.get(owner.dir) ?? diags.set(owner.dir, []).get(owner.dir)).push({ file, line: Number(m[2]), msg: m[4] });
			}
			for (const p of pkgs) {
				const d = diags.get(p.dir) ?? [];
				if (d.length) results.set(p.dir, { status: "fail", failures: d.map((x) => ({ id: `${p.importPath}:vet:${x.file}:${x.msg}`, title: `${x.file ? `${x.file}:${x.line}: ` : ""}${x.msg}`, output: "" })), output: d.map((x) => `${x.file}:${x.line}: ${x.msg}`).join("\n") });
				else if (r.code !== 0 && !diags.size) results.set(p.dir, { status: "fail", failures: [{ id: `${p.importPath}:vet:[error]`, title: "go vet failed", output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) }], output: r.stderr.slice(-4000) });
				else results.set(p.dir, { status: "pass", failures: [], passed: 1, output: "" });
			}
			return { results, ms: r.ms, killed: r.killed };
		}
		// test — events stream in; each package's result is reported as soon as go finishes it
		const args = ["test", "-json", "-count=1", ...(opts?.args ?? []), ...extraArgs];
		if (opts?.timeout && !extraArgs.some((a) => a.startsWith("-timeout"))) args.push("-timeout", String(opts.timeout));
		args.push(...pkgs.map((p) => p.rel));
		const timeoutIndex = args.findLastIndex((a) => a === "-timeout" || a.startsWith("-timeout="));
		const timeout = timeoutIndex < 0 ? "10m" : args[timeoutIndex].includes("=") ? args[timeoutIndex].slice(9) : args[timeoutIndex + 1];
		const goTimeout = parseDuration(timeout, 10 * 60000);
		const per = new Map();
		const buildOut = new Map();
		const byIp = new Map(pkgs.map((p) => [p.importPath, p]));
		const get = (ip) => {
			let x = per.get(ip);
			if (!x) per.set(ip, (x = { tests: new Map(), out: [], status: undefined, elapsed: 0 }));
			return x;
		};
		const finish = (p, killed = false, stderr = "") => {
			const x = per.get(p.importPath);
			const out = x ? x.out.join("") : "";
			if (x && (x.status === "pass" || x.status === "skip")) {
				const passed = [...x.tests.entries()].filter(([n, t]) => t.status === "pass" && !n.includes("/")).length;
				return { status: "pass", failures: [], passed, output: out.slice(-200000), seconds: x.elapsed };
			}
			if (x && x.status === "fail") {
				const failed = [...x.tests.entries()].filter(([, t]) => t.status === "fail");
				const leaves = failed.filter(([n]) => !failed.some(([m]) => m !== n && m.startsWith(`${n}/`)));
				const failures = leaves.map(([n, t]) => ({ id: `${p.importPath}:${n}`, title: `${p.importPath} ${n}`, output: t.out.join("").slice(-6000) }));
				const timedOut = /panic: test timed out after/.test(out);
				if (!failures.length || timedOut) {
					const why = (buildOut.get(p.importPath) ?? "") + out;
					const built = buildOut.has(p.importPath) || /\[build failed\]|\[setup failed\]/.test(out);
					if (!failures.length) failures.push({ id: `${p.importPath}:${built ? "[build]" : timedOut ? "[timeout]" : "[package]"}`, title: `${p.importPath} ${built ? "does not build" : timedOut ? `timed out (${(out.match(/timed out after (\S+)/) ?? [])[1] ?? ""}) — raise the timeout: go test -timeout 30m, or "timeout" for this project in pi-check.json` : "failed (no single test to blame: panic or TestMain)"}`, output: why.slice(-6000) });
				}
				const passed = [...x.tests.entries()].filter(([n, t]) => t.status === "pass" && !n.includes("/")).length;
				// a timeout says nothing about the code: report it, never cache it
				return { status: timedOut ? "error" : "fail", failures, passed, output: out.slice(-200000), seconds: x.elapsed };
			}
			const why = buildOut.get(p.importPath) ?? "";
			if (killed) return { status: "error", failures: [{ id: `${p.importPath}:[killed]`, title: `${p.importPath}: run stopped (timeout or cancelled)`, output: stderr.slice(-3000) }], output: "" };
			return { status: "fail", failures: [{ id: `${p.importPath}:[build]`, title: `${p.importPath} does not build`, output: (why || stderr).slice(-6000) }], output: why };
		};
		const done = new Set();
		let buf = "";
		const onLine = (line) => {
			if (!line.startsWith("{")) return;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				return;
			}
			if (e.Action === "build-output" || e.Action === "build-fail") {
				const ip = String(e.ImportPath ?? "").replace(/\s.*$/, "");
				if (e.Output) buildOut.set(ip, (buildOut.get(ip) ?? "") + e.Output);
				return;
			}
			if (!e.Package) return;
			const x = get(e.Package);
			if (["run", "pass", "fail", "skip"].includes(e.Action)) onProgress?.(`${e.Package}${e.Test ? ` ${e.Test}` : ""}: ${e.Action}`);
			if (e.Test) {
				let t = x.tests.get(e.Test);
				if (!t) x.tests.set(e.Test, (t = { status: undefined, out: [] }));
				if (e.Action === "output") {
					t.out.push(e.Output);
					x.out.push(e.Output);
				} else if (["pass", "fail", "skip"].includes(e.Action)) t.status = e.Action;
			} else if (e.Action === "output") x.out.push(e.Output);
			else if (["pass", "fail", "skip"].includes(e.Action)) {
				x.status = e.Action;
				x.elapsed = e.Elapsed ?? 0;
				const p = byIp.get(e.Package);
				if (p && !done.has(p.dir)) {
					done.add(p.dir);
					const res = finish(p);
					results.set(p.dir, res);
					onUnit?.(p.dir, res);
				}
			}
		};
		const r = await runProc({
			cmd: goBin,
			args,
			cwd,
			env,
			signal,
			nice,
			timeoutMs: goTimeout * Math.max(1, Math.ceil(pkgs.length / threads)) + 120000,
			onData: (d, stream) => {
				if (stream !== "stdout") return;
				buf += d;
				let i;
				while ((i = buf.indexOf("\n")) >= 0) {
					onLine(buf.slice(0, i));
					buf = buf.slice(i + 1);
				}
			},
		});
		if (buf) onLine(buf);
		// build errors printed to stderr by older Go versions: "# importpath" blocks
		let cur;
		for (const line of r.stderr.split("\n")) {
			const h = line.match(/^# (\S+)/);
			if (h) {
				cur = h[1];
				continue;
			}
			if (cur && line.trim()) buildOut.set(cur, (buildOut.get(cur) ?? "") + `${line}\n`);
		}
		for (const p of pkgs) if (!done.has(p.dir)) results.set(p.dir, finish(p, r.killed, r.stderr));
		return { results, ms: r.ms, killed: r.killed };
	},
};

export default adapter;
export { parseGoFile, closure as goClosure };
export const goBinary = () => which("go", { skipDir: SHIM_DIR }) ?? "go";
