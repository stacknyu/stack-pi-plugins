// Custom checks from pi-check.json: { name, cwd, cmd, inputs: [globs, repo-relative], timeout, env, parallel }
import { cleanEnv, matchAny, parseDuration, runProc, sha } from "../util.mjs";

const adapter = {
	lang: "custom",
	version: 2,
	detect(rc) {
		return (rc.config.custom ?? [])
			.filter((c) => c?.name && c?.cmd)
			.map((c) => ({ id: `custom:${c.name}`, lang: "custom", dir: c.cwd ?? ".", name: c.name, kinds: ["custom"], meta: c }));
	},
	units(rc, project) {
		const c = project.meta;
		const globs = c.inputs?.length ? c.inputs : [project.dir === "." ? "**" : `${project.dir}/**`];
		return [{ target: c.name, label: c.name, inputs: rc.listing().files.filter((f) => matchAny(globs, f)) }];
	},
	group(project) {
		return { name: `custom:${project.meta.name}`, limit: project.meta.parallel ?? 1 };
	},
	batchSize: () => 1,
	argsKey(_opts, project) {
		return JSON.stringify({ cmd: project.meta.cmd, env: project.meta.env ?? {} });
	},
	async run({ rc, project, units, signal, nice, threads }) {
		const c = project.meta;
		const env = cleanEnv({ ...(c.env ?? {}), PI_CHECK_BYPASS: "1", GOMAXPROCS: String(threads), GOFLAGS: `${process.env.GOFLAGS ?? ""} -p=1`.trim() });
				const r = await runProc({ cmd: "/bin/sh", args: ["-c", c.cmd], cwd: rc.path(project.dir), env, signal, nice, timeoutMs: parseDuration(c.timeout, 30 * 60000) });
		const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
		const u = units[0];
		const results = new Map([[u.target, r.code === 0 ? { status: "pass", failures: [], passed: 1, output: out.slice(-20000) } : { status: r.killed ? "error" : "fail", failures: [{ id: `custom:${c.name}:${sha(out.split(rc.abs).join("<checkout>")).slice(0, 16)}`, title: `${c.name} failed (exit ${r.code})`, output: out.slice(-6000) }], output: out.slice(-20000) }]]);
		return { results, ms: r.ms, killed: r.killed };
	},
};

export default adapter;
