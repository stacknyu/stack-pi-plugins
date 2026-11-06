// Talk to the repo's broker, starting it when needed.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import http from "node:http";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR, SHIM_DIR, STATE_DIR, VERSION, loadJson, pidAlive, repoRoots } from "./util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BROKER = join(HERE, "broker.mjs");
export const CLI = join(HERE, "..", "cli.mjs");
export { SHIM_DIR };

export function cleanPath(p = process.env.PATH ?? "") {
	return p
		.split(delimiter)
		.filter((d) => d && resolve(d) !== resolve(SHIM_DIR))
		.join(delimiter);
}

function request(info, path, body, onEvent, timeoutMs) {
	return new Promise((res, rej) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = http.request({ host: "127.0.0.1", port: info.port, path, method: data === undefined ? "GET" : "POST", headers: { "x-pi-check-token": info.token, "content-type": "application/json" } }, (r) => {
			let buf = "";
			let last;
			const nd = String(r.headers["content-type"] ?? "").includes("ndjson");
			r.on("data", (d) => {
				buf += d;
				if (!nd) return;
				let i;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (!line.trim()) continue;
					try {
						const ev = JSON.parse(line);
						if (ev.type === "result" || ev.type === "error") last = ev;
						else onEvent?.(ev);
					} catch {}
				}
			});
			r.on("end", () => {
				if (nd) {
					if (last?.type === "error") return rej(new Error(last.error));
					return last ? res(last) : rej(new Error("broker closed the connection without a result"));
				}
				try {
					const j = JSON.parse(buf || "{}");
					if (r.statusCode >= 400) rej(new Error(j.error ?? `HTTP ${r.statusCode}`));
					else res(j);
				} catch (e) {
					rej(e);
				}
			});
		});
		req.on("error", rej);
		if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		if (data !== undefined) req.write(data);
		req.end();
	});
}

async function ping(info) {
	try {
		const r = await request(info, "/ping", undefined, undefined, 2000);
		return r?.ok ? r : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** -> { info, root, main } ; starts the broker unless start=false. */
export async function connect(cwd, { start = true } = {}) {
	const rr = repoRoots(cwd);
	if (!rr) throw new Error(`${cwd} is not inside a git repository`);
	const dir = join(rr.main, STATE_DIR);
	const file = join(dir, "broker.json");
	let info = loadJson(file);
	if (info && pidAlive(info.pid)) {
		const p = await ping(info);
		if (p && p.version === VERSION) return { info, ...rr };
		if (p && p.version !== VERSION) {
			const status = await request(info, "/status", undefined, undefined, 3000);
			if (status.running?.length || status.pending?.requested) {
				throw new Error("pi-check upgrade pending: existing checks are still running; let them finish before reloading");
			}
			if (!start) return { info, ...rr };
			// Only replace an idle broker; never kill another session's verification.
			try {
				await request(info, "/stop", {}, undefined, 3000);
			} catch {}
			await sleep(800);
		}
	}
	if (!start) return { info: undefined, ...rr };
	mkdirSync(dir, { recursive: true });
	const log = openSync(join(dir, "broker.out"), "a");
	const env = { ...process.env, PATH: cleanPath() };
	delete env.PI_CHECK_SHIM_DIR;
	spawn(process.execPath, [BROKER, rr.main], { cwd: rr.main, detached: true, stdio: ["ignore", log, log], env }).unref();
	for (let i = 0; i < 100; i++) {
		await sleep(150);
		info = loadJson(file);
		if (info && pidAlive(info.pid) && (await ping(info))) return { info, ...rr };
	}
	throw new Error(`pi-check broker did not start (see ${join(dir, "broker.out")})`);
}

export async function call(cwd, path, body, onEvent, opts = {}) {
	const c = await connect(cwd, opts);
	if (!c.info) return undefined;
	return request(c.info, path, body === undefined ? undefined : { root: c.root, ...body }, onEvent, opts.timeoutMs);
}

/** `go` shim that routes `go test` / `go vet` through the broker. */
export function installShims(node = process.execPath) {
	mkdirSync(SHIM_DIR, { recursive: true });
	const go = join(SHIM_DIR, "go");
	writeFileSync(go, `#!/bin/sh\n# pi-check shim: go test / go vet go through the shared check broker; everything else is the real go.\nPI_CHECK_SHIM_DIR='${SHIM_DIR}' exec '${node}' '${CLI}' shim go "$@"\n`);
	chmodSync(go, 0o755);
	writeFileSync(join(HOME_DIR, "cli.json"), JSON.stringify({ cli: CLI, node, shims: SHIM_DIR, version: VERSION }, null, 2));
	return SHIM_DIR;
}
