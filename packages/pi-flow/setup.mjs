// pi-flow setup: detect the repo's stack, verify check commands by running them once,
// apply your saved plugin profile, and keep a short managed block in AGENTS.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { LOGIN_SHELL, cleanEnv, git, loadJson, resolvePi, run, tail } from "./runner.mjs";

export const FLOW_DIR = ".pi-flow";
export const TASKS_DIR = ".tasks";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
export const PROFILE = join(AGENT_DIR, "pi-flow", "profile.json");
const SKIP = new Set(["node_modules", ".git", ".pi-queue", ".pi-flow", "dist", "build", ".next", ".turbo", "vendor", "target"]);

/** Keep a path out of git without touching .gitignore (uses .git/info/exclude). */
export async function exclude(repo, path) {
	const rel = (await git(repo, "rev-parse", "--git-path", "info/exclude")).out.trim();
	if (!rel) return;
	const file = isAbsolute(rel) ? rel : join(repo, rel);
	mkdirSync(dirname(file), { recursive: true });
	const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (!cur.split("\n").includes(path)) appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${path}\n`);
}

// ---------- stack detection ----------

function readJson(p) {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return undefined;
	}
}

function dirsMatching(repo, pattern) {
	const clean = pattern.replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/$/, "");
	if (!clean || clean.startsWith("!")) return [];
	const parts = clean.split("/");
	const out = [];
	const walk = (base, i) => {
		if (i === parts.length) return out.push(base);
		const part = parts[i];
		const abs = join(repo, base);
		if (part === "**") {
			walk(base, i + 1);
			for (const d of subdirs(abs)) walk(join(base, d), i);
			return;
		}
		if (part.includes("*")) {
			const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			for (const d of subdirs(abs)) if (re.test(d)) walk(join(base, d), i + 1);
			return;
		}
		if (existsSync(join(abs, part))) walk(join(base, part), i + 1);
	};
	walk("", 0);
	return out.filter((d) => existsSync(join(repo, d, "package.json")));
}

function subdirs(abs) {
	try {
		return readdirSync(abs).filter((d) => !SKIP.has(d) && !d.startsWith(".") && statSync(join(abs, d)).isDirectory());
	} catch {
		return [];
	}
}

function findFiles(repo, name, depth = 3, base = "") {
	const out = [];
	if (existsSync(join(repo, base, name))) out.push(base || ".");
	if (depth === 0) return out;
	for (const d of subdirs(join(repo, base))) out.push(...findFiles(repo, name, depth - 1, join(base, d)));
	return out;
}

export function detect(repo) {
	const has = (f) => existsSync(join(repo, f));
	const pm = has("pnpm-lock.yaml") ? "pnpm" : has("bun.lock") || has("bun.lockb") ? "bun" : has("yarn.lock") ? "yarn" : has("package-lock.json") ? "npm" : has("package.json") ? "npm" : "";
	const install = {
		pnpm: "pnpm install --frozen-lockfile --prefer-offline",
		bun: "bun install --frozen-lockfile",
		yarn: "yarn install --frozen-lockfile",
		npm: "npm ci --prefer-offline --no-audit --no-fund",
	}[pm] ?? "";

	// workspace packages
	let patterns = [];
	if (has("pnpm-workspace.yaml")) {
		let inPackages = false;
		for (const line of readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8").split("\n")) {
			if (/^packages\s*:/.test(line)) inPackages = true;
			else if (/^\S/.test(line)) inPackages = false;
			else if (inPackages) {
				const m = line.match(/^\s*-\s*(.+?)\s*$/);
				if (m) patterns.push(m[1]);
			}
		}
	}
	const rootPkg = readJson(join(repo, "package.json"));
	const ws = rootPkg?.workspaces;
	if (Array.isArray(ws)) patterns.push(...ws);
	else if (Array.isArray(ws?.packages)) patterns.push(...ws.packages);
	const dirs = [...new Set(patterns.flatMap((p) => dirsMatching(repo, p)))].sort();
	if (dirs.length === 0 && rootPkg) dirs.push(".");

	const packages = dirs.map((dir) => {
		const pkg = readJson(join(repo, dir, "package.json")) ?? {};
		return { dir, name: pkg.name ?? dir, scripts: pkg.scripts ?? {}, tsconfig: existsSync(join(repo, dir, "tsconfig.json")) };
	});
	const go = findFiles(repo, "go.mod");
	const cargo = findFiles(repo, "Cargo.toml", 2).filter((d) => d === "." || !existsSync(join(repo, "Cargo.toml")));
	return { pm, install, packages, go, cargo };
}

/** Check commands worth trying, per package. Tests are listed but not run (they can be slow or need services). */
export function candidates(repo, det) {
	const runS = { pnpm: "pnpm run", bun: "bun run", yarn: "yarn run", npm: "npm run" }[det.pm] ?? "npm run";
	const execTsc = { pnpm: "pnpm exec tsc --noEmit", bun: "bunx tsc --noEmit", yarn: "yarn tsc --noEmit", npm: "npx --no-install tsc --noEmit" }[det.pm] ?? "npx --no-install tsc --noEmit";
	const at = (dir, cmd) => (dir === "." ? cmd : `cd ${dir} && ${cmd}`);
	const out = [];
	const tscAvailable = (dir) => existsSync(join(repo, dir, "node_modules", ".bin", "tsc")) || existsSync(join(repo, "node_modules", ".bin", "tsc"));
	for (const p of det.packages) {
		const s = p.scripts;
		const tc = ["typecheck", "type-check", "check-types", "types", "tsc"].find((k) => s[k]);
		if (tc) out.push({ dir: p.dir, kind: "typecheck", cmd: at(p.dir, `${runS} ${tc}`) });
		else if (p.tsconfig && tscAvailable(p.dir)) out.push({ dir: p.dir, kind: "typecheck", cmd: at(p.dir, execTsc) });
		if (s.lint) out.push({ dir: p.dir, kind: "lint", cmd: at(p.dir, `${runS} lint`) });
		if (s.check && !tc) out.push({ dir: p.dir, kind: "check", cmd: at(p.dir, `${runS} check`) });
		if (s.test) out.push({ dir: p.dir, kind: "test", cmd: at(p.dir, `${runS} test`), notRun: true });
	}
	for (const d of det.go) {
		out.push({ dir: d, kind: "build", cmd: at(d, "go build ./...") });
		out.push({ dir: d, kind: "vet", cmd: at(d, "go vet ./...") });
		out.push({ dir: d, kind: "test", cmd: at(d, "go test ./..."), notRun: true });
	}
	for (const d of det.cargo) out.push({ dir: d, kind: "build", cmd: at(d, "cargo check") });
	return out;
}

/** Run each candidate once on the current code. Only commands that pass can become a task's checks. */
export async function verify(repo, cands, onProgress = () => {}, minutes = 10) {
	const results = [];
	let i = 0;
	for (const c of cands) {
		i++;
		if (c.notRun) {
			results.push({ ...c, ok: null });
			continue;
		}
		onProgress(`checking ${i}/${cands.length}: ${c.cmd}`);
		const t0 = Date.now();
		const r = await run(repo, LOGIN_SHELL, ["-lc", c.cmd], { timeoutMs: minutes * 60_000, env: cleanEnv() });
		results.push({ ...c, ok: r.code === 0, seconds: Math.round((Date.now() - t0) / 1000), ...(r.code === 0 ? {} : { output: tail(r.out, 15) }) });
	}
	return results;
}

// ---------- AGENTS.md ----------

const START = "<!-- pi-flow:start -->";
const END = "<!-- pi-flow:end -->";
export const AGENTS_BLOCK = `${START}
## How large work runs here (pi-flow)

- Large tasks start with \`/task <request>\`: a planning session researches and writes \`${TASKS_DIR}/<task>/\` (brief, inventory, maps, rules, questions, items), asks the user its open questions, then hands the item list to the queue.
- Queue items run unattended, each in a fresh session: never ask the user questions; stay inside the item and the task's allowed paths; do not commit; run the task's checks before stopping. Reply \`NEEDS: <files> files, <lines> lines\` if the item needs more than its size limits, or \`BLOCKED: <reason>\` if it cannot be done without a decision.
- Subagents may read, search and research; only the main agent edits files.
- A task's \`brief.md\`, \`rules.md\` and answered \`questions.md\` narrow the scope for that task; they never loosen the rules in this file.
${END}`;

/** Insert or refresh the managed block; drop stale harness blocks from earlier setups. Returns notes. */
export function updateAgents(repo) {
	const file = join(repo, "AGENTS.md");
	const notes = [];
	let text = existsSync(file) ? readFileSync(file, "utf8") : "# Agent rules\n";
	const stale = /<!-- harness:long-running:start -->[\s\S]*?<!-- harness:long-running:end -->\n?/g;
	if (stale.test(text)) {
		text = text.replace(stale, "");
		notes.push("removed the old long-running harness block (GLLA) from AGENTS.md");
	}
	if (text.includes(START) && text.includes(END)) {
		const before = text;
		text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), AGENTS_BLOCK);
		if (before !== text) notes.push("refreshed the pi-flow block in AGENTS.md");
	} else {
		text = `${text.trimEnd()}\n\n${AGENTS_BLOCK}\n`;
		notes.push(existsSync(file) ? "added the pi-flow block to AGENTS.md" : "created AGENTS.md with the pi-flow block");
	}
	const leftovers = text.split("\n").filter((l) => /\bGLLA\b|\/goal\b|pi-goal/i.test(l) && !l.includes("pi-flow"));
	if (leftovers.length) notes.push(`AGENTS.md still mentions the old loop in ${leftovers.length} line(s), e.g. "${leftovers[0].trim().slice(0, 80)}" — review it`);
	writeFileSync(file, text);
	return notes;
}

// ---------- plugin profile ----------

function packagesOf(settingsFile) {
	return (readJson(settingsFile)?.packages ?? []).map((p) => (typeof p === "string" ? p : p?.source)).filter(Boolean);
}

/** Save this repo's project plugins (.pi/settings.json) as your profile for other repos. */
export function saveProfile(repo) {
	const settings = readJson(join(repo, ".pi", "settings.json")) ?? {};
	const packages = (settings.packages ?? []).filter((p) => {
		const src = typeof p === "string" ? p : p?.source;
		return src && !/^\.{1,2}\//.test(src); // repo-relative local packages cannot move to another repo
	});
	const { packages: _p, ...rest } = settings;
	mkdirSync(dirname(PROFILE), { recursive: true });
	writeFileSync(PROFILE, `${JSON.stringify({ savedFrom: repo, savedAt: new Date().toISOString(), packages, settings: rest }, null, 2)}\n`);
	return { file: PROFILE, count: packages.length };
}

/** Install the profile's plugins into this repo (pi install -l) and copy its other project settings where unset. */
export async function applyProfile(repo, onProgress = () => {}) {
	const profile = loadJson(PROFILE, null);
	if (!profile) return { notes: ["no plugin profile yet: run /task save-profile in a repo whose plugins you like"], installed: [] };
	const settingsFile = join(repo, ".pi", "settings.json");
	const have = new Set([...packagesOf(settingsFile), ...packagesOf(join(AGENT_DIR, "settings.json"))]);
	const pi = await resolvePi({});
	const installed = [];
	const notes = [];
	for (const p of profile.packages ?? []) {
		const src = typeof p === "string" ? p : p.source;
		if (have.has(src)) continue;
		onProgress(`installing ${src}`);
		const r = await run(repo, LOGIN_SHELL, ["-lc", `"${pi}" install -l "$0"`, src], { timeoutMs: 10 * 60_000, env: cleanEnv() });
		if (r.code === 0) installed.push(src);
		else notes.push(`could not install ${src}: ${tail(r.out, 2).replace(/\n/g, " ")}`);
	}
	// object-form package filters and other project settings: merge where this repo has nothing
	const cur = readJson(settingsFile) ?? {};
	let changed = false;
	for (const [k, v] of Object.entries(profile.settings ?? {})) {
		if (cur[k] === undefined) {
			cur[k] = v;
			changed = true;
		}
	}
	const objs = (profile.packages ?? []).filter((p) => typeof p === "object");
	if (objs.length) {
		cur.packages = (cur.packages ?? []).map((p) => {
			const src = typeof p === "string" ? p : p.source;
			return objs.find((o) => o.source === src) ?? p;
		});
		changed = true;
	}
	if (changed) {
		mkdirSync(dirname(settingsFile), { recursive: true });
		writeFileSync(settingsFile, `${JSON.stringify(cur, null, 2)}\n`);
	}
	return { notes, installed };
}

// ---------- the whole setup ----------

export async function setupRepo(repo, onProgress = () => {}) {
	const notes = [];
	if ((await git(repo, "rev-parse", "--is-inside-work-tree")).out.trim() !== "true") throw new Error("not a git repository");
	mkdirSync(join(repo, FLOW_DIR), { recursive: true });
	await exclude(repo, `${FLOW_DIR}/`);
	await exclude(repo, ".pi-queue/");

	const dirtyBefore = (await git(repo, "status", "--porcelain", "--", "AGENTS.md", ".pi/settings.json")).out.trim();

	onProgress("plugins");
	const prof = await applyProfile(repo, onProgress);
	notes.push(...prof.notes);
	if (prof.installed.length) notes.push(`installed ${prof.installed.length} plugin(s): ${prof.installed.join(", ")}`);

	notes.push(...updateAgents(repo));

	onProgress("detecting the stack");
	const det = detect(repo);
	const cands = candidates(repo, det);
	const checks = await verify(repo, cands, onProgress);
	const info = { updatedAt: new Date().toISOString(), pm: det.pm, install: det.install, packages: det.packages.map(({ dir, name }) => ({ dir, name })), go: det.go, cargo: det.cargo, checks };
	writeFileSync(join(repo, FLOW_DIR, "repo.json"), `${JSON.stringify(info, null, 2)}\n`);

	// commit setup's own files, only if they were clean before (never sweep up your edits)
	if (!dirtyBefore) {
		const changed = (await git(repo, "status", "--porcelain", "--", "AGENTS.md", ".pi/settings.json")).out.trim();
		if (changed) {
			await git(repo, "add", "--", "AGENTS.md", ...(existsSync(join(repo, ".pi", "settings.json")) ? [".pi/settings.json"] : []));
			const c = await git(repo, "commit", "-m", "pi-flow setup", "--", "AGENTS.md", ...(existsSync(join(repo, ".pi", "settings.json")) ? [".pi/settings.json"] : []));
			notes.push(c.code === 0 ? "committed AGENTS.md / .pi/settings.json as \"pi-flow setup\"" : `could not commit setup changes: ${tail(c.out, 2)}`);
		}
	} else notes.push("AGENTS.md or .pi/settings.json had your own uncommitted edits, so setup did not commit; commit them yourself before /task");

	const ok = checks.filter((c) => c.ok === true);
	const bad = checks.filter((c) => c.ok === false);
	const report = [
		`# pi-flow setup — ${info.updatedAt}`,
		"",
		`Package manager: ${det.pm || "none"}${det.install ? ` (worktree install: \`${det.install}\`)` : ""}`,
		`Packages: ${det.packages.map((p) => p.dir).join(", ") || "none"}${det.go.length ? ` · Go: ${det.go.join(", ")}` : ""}${det.cargo.length ? ` · Rust: ${det.cargo.join(", ")}` : ""}`,
		"",
		"## Checks that pass today (usable as task checks)",
		...ok.map((c) => `- \`${c.cmd}\` (${c.kind}, ${c.seconds}s)`),
		"",
		"## Checks that fail today (not used until fixed)",
		...bad.map((c) => `- \`${c.cmd}\` (${c.kind})\n\n  \`\`\`\n${(c.output ?? "").split("\n").map((l) => `  ${l}`).join("\n")}\n  \`\`\``),
		"",
		"## Available but not run (tests)",
		...checks.filter((c) => c.ok === null).map((c) => `- \`${c.cmd}\``),
		"",
		"## Notes",
		...notes.map((n) => `- ${n}`),
	].join("\n");
	writeFileSync(join(repo, FLOW_DIR, "setup-report.md"), `${report}\n`);
	return { info, notes, ok: ok.length, bad: bad.length, report };
}
