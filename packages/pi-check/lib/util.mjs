// Shared helpers: paths, git, hashing, globs, processes.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STATE_DIR = ".pi-check";
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const HOME_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-check");
export const SHIM_DIR = join(HOME_DIR, "shims");

export const CPUS = Math.max(1, cpus()?.length || 2);

// ---------- small io ----------

export function readText(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

export function loadJson(p, fallback = undefined) {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return fallback;
	}
}

export function writeJson(p, data) {
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, p);
}

export function ensureDir(p) {
	mkdirSync(p, { recursive: true });
	return p;
}

/** JSON with comments and trailing commas (tsconfig, etc). */
export function parseJsonc(text) {
	let out = "";
	let i = 0;
	let inStr = false;
	while (i < text.length) {
		const c = text[i];
		const n = text[i + 1];
		if (inStr) {
			out += c;
			if (c === "\\") {
				out += n ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inStr = false;
			i++;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && n === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && n === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	out = out.replace(/,(\s*[}\]])/g, "$1");
	try {
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}

export function loadJsonc(p) {
	const t = readText(p);
	return t ? parseJsonc(t) : undefined;
}

// ---------- paths ----------

export const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));
export const rel = (from, to) => toPosix(relative(from, to)) || ".";

export function isUnder(relPath, dir) {
	if (!dir || dir === ".") return true;
	return relPath === dir || relPath.startsWith(dir + "/");
}

export function parentDirs(relPath) {
	// "a/b/c.ts" -> ["a/b", "a", "."]
	const out = [];
	let d = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
	while (true) {
		out.push(d);
		if (d === ".") break;
		d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : ".";
	}
	return out;
}

export const dirOf = (relPath) => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".");
export const baseOf = (relPath) => relPath.slice(relPath.lastIndexOf("/") + 1);
export const joinRel = (a, b) => (a === "." || !a ? b : b === "." ? a : `${a}/${b}`);

export function normRel(p) {
	const parts = [];
	for (const seg of toPosix(p).split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/") || ".";
}

// ---------- git ----------

export function git(cwd, args, opts = {}) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, ...opts });
	return { ok: r.status === 0, out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString() };
}

/** The checkout this path is in, and the repo's main checkout (shared by all worktrees). */
export function repoRoots(cwd) {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) return undefined;
	const root = top.out.trim();
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	let main = root;
	if (common.ok) {
		const c = common.out.trim();
		if (c.endsWith("/.git") || c.endsWith(`${sep}.git`)) main = dirname(c);
	}
	return { root, main };
}

// ---------- hashing ----------

export const sha = (s, algo = "sha256") => createHash(algo).update(s).digest("hex");

/** Content hashes with an (mtime, size, inode) memo, so unchanged files are never re-read. */
export class FileHasher {
	constructor() {
		this.memo = new Map();
		this.reads = 0;
	}
	hash(abs) {
		let st;
		try {
			st = statSync(abs);
		} catch {
			this.memo.delete(abs);
			return "-";
		}
		if (!st.isFile()) return "d";
		const m = this.memo.get(abs);
		if (m && m.mtimeMs === st.mtimeMs && m.size === st.size && m.ino === st.ino) return m.hash;
		let hash;
		try {
			hash = createHash("sha1").update(readFileSync(abs)).digest("hex");
			this.reads++;
		} catch {
			hash = "-";
		}
		this.memo.set(abs, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, hash });
		if (this.memo.size > 400000) this.memo.clear();
		return hash;
	}
	/** Read a text file through the same memo (used for import scanning). */
	text(abs) {
		return readText(abs);
	}
}

// ---------- globs ----------

const globCache = new Map();
export function globToRegex(glob) {
	let g = globCache.get(glob);
	if (g) return g;
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				re += slash ? "(?:.*/)?" : ".*";
				i += slash ? 3 : 2;
				continue;
			}
			re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end > i) {
				re += `(?:${glob
					.slice(i + 1, end)
					.split(",")
					.map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
					.join("|")})`;
				i = end + 1;
				continue;
			}
			re += "\\{";
		} else if (".+^$()|[]\\".includes(c)) re += `\\${c}`;
		else re += c;
		i++;
	}
	g = new RegExp(`^${re}$`);
	globCache.set(glob, g);
	return g;
}

export const matchGlob = (glob, relPath) => globToRegex(glob).test(relPath);
export const matchAny = (globs, relPath) => (globs ?? []).some((g) => matchGlob(g, relPath));

// ---------- processes ----------

export function which(cmd, { skipDir, pathEnv = process.env.PATH ?? "" } = {}) {
	if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : undefined;
	for (const d of pathEnv.split(delimiter)) {
		if (!d || (skipDir && resolve(d) === resolve(skipDir))) continue;
		const p = join(d, cmd);
		try {
			accessSync(p, constants.X_OK);
			if (statSync(p).isFile()) return p;
		} catch {}
	}
	return undefined;
}

/** First executable named `name` in node_modules/.bin from dir up to stopAt (inclusive), then alt roots. */
export function findBin(name, absDir, stopAt, alsoTry = []) {
	const tryDirs = [];
	let d = absDir;
	while (true) {
		tryDirs.push(d);
		if (d === stopAt || dirname(d) === d) break;
		d = dirname(d);
	}
	for (const extra of alsoTry) if (extra) tryDirs.push(extra);
	for (const dir of tryDirs) {
		const p = join(dir, "node_modules", ".bin", name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

export const NICE = which("nice");

/**
 * Run a process in its own process group. Resolves { code, stdout, stderr, killed, ms }.
 * `signal` (AbortSignal) kills the whole group.
 */
export function runProc({ cmd, args = [], cwd, env, signal, timeoutMs, nice = 10, onData, maxBytes = 8 * 1024 * 1024 }) {
	return new Promise((resolveP) => {
		const started = Date.now();
		const argv = nice && NICE ? [NICE, "-n", String(nice), cmd, ...args] : [cmd, ...args];
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			resolveP({ code: 127, stdout: "", stderr: String(e?.message ?? e), killed: false, ms: 0 });
			return;
		}
		let stdout = "";
		let stderr = "";
		let killed = false, killTimer;
		const cap = (buf, add) => {
			buf += add;
			return buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
		};
		child.stdout.on("data", (d) => {
			const s = d.toString();
			stdout = cap(stdout, s);
			onData?.(s, "stdout");
		});
		child.stderr.on("data", (d) => {
			const s = d.toString();
			stderr = cap(stderr, s);
			onData?.(s, "stderr");
		});
		const kill = () => {
			if (killed) return;
			killed = true;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}, 3000).unref();
		};
		const onAbort = () => kill();
		signal?.addEventListener("abort", onAbort);
		if (signal?.aborted) kill();
		const timer = timeoutMs ? setTimeout(kill, timeoutMs) : undefined;
		child.on("error", (e) => {
			stderr += String(e?.message ?? e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			resolveP({ code: code ?? (killed ? 143 : 1), stdout, stderr, killed, ms: Date.now() - started });
		});
	});
}

/** Environment for checks: no npm/pnpm script variables leaking from whoever started the broker. */
const POLLUTED = /^(npm_.*|PNPM_.*|pnpm_.*|INIT_CWD|NODE_ENV|NODE_OPTIONS|NEXT_.*|PORT|HOSTNAME|PI_WEB_.*|PI_CHECK_SHIM_DIR|VITEST.*|JEST_WORKER_ID)$/;
export function cleanEnv(extra = {}) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) if (!POLLUTED.test(k)) env[k] = v;
	return { ...env, ...extra };
}

/** PATH as the user's login shell sets it (Homebrew, Go, pyenv…), merged into this process once. */
export function adoptLoginPath() {
	const sh = process.env.SHELL || "/bin/sh";
	try {
		const r = spawnSync(sh, ["-lc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 8000 });
		const login = (r.stdout ?? "").trim();
		if (!login) return;
		const cur = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
		const add = login.split(delimiter).filter((d) => d && !cur.includes(d));
		if (add.length) process.env.PATH = [...cur, ...add].join(delimiter);
	} catch {}
}

export function parseDuration(v, fallbackMs) {
	if (v == null || v === "") return fallbackMs;
	if (typeof v === "number") return v * 1000;
	const m = String(v).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
	if (!m) return fallbackMs;
	const n = Number(m[1]);
	return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] ?? "s"] ?? 1000);
}

export function fmtMs(ms) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export function tailLines(text, n) {
	const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
	return lines.length <= n ? lines.join("\n") : `… (${lines.length - n} earlier lines)\n${lines.slice(-n).join("\n")}`;
}

export function headLines(text, n) {
	const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
	return lines.length <= n ? lines.join("\n") : `${lines.slice(0, n).join("\n")}\n… (${lines.length - n} more lines)`;
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function logTo(file) {
	return (...parts) => {
		const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
		try {
			appendFileSync(file, line);
		} catch {}
	};
}

export function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM";
	}
}
