import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DOM_OBSERVER } from "./scripts/sensors/dom_observer.mjs";
import { REACT_SENSOR } from "./scripts/sensors/react_sensor.mjs";
import { analyzeScenario } from "./scripts/glitch/analyze.mjs";
import { loadPlaywright, launchBrowser, bounded, requireInteraction, parseArgs, tpl, resolveCells } from "./scripts/lib.mjs";
import extension from "./extensions/index.ts";
const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "glitch-lab-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
async function cli(home, script, ...args) {
  try {
    const r = await exec(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: home, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    return { ...r, code: 0 };
  } catch (e) { return { stdout: e.stdout, stderr: e.stderr, code: e.code }; }
}
async function app(t) {
  let name = "Before", writes = 0, foreignRequests = 0, nextRequests = 0;
  const foreign = createServer((_req, res) => { foreignRequests++; res.end("foreign"); });
  await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
  t.after(() => { foreign.closeAllConnections(); foreign.close(); });
  const shell = (body) => `<!doctype html><html><head><link rel="icon" href="/favicon.ico"><style>button,a,input{display:inline-block;margin:8px;padding:8px}body{font:16px sans-serif}</style></head><body>${body}</body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/react") { res.setHeader("content-type", "text/html"); res.end(readFileSync(path.join(root, "examples/glitchy-app/public/index.html"))); return; }
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(path.join(root, "examples/glitchy-app/public/app.js"))); return; }
    if (url.pathname.startsWith("/api/") && req.method === "GET") { res.setHeader("content-type", "application/json"); res.end('{"ok":1}'); return; }
    if (url.pathname === "/favicon.ico") { res.statusCode = 204; res.end(); return; }
    if (url.pathname === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${foreign.address().port}/trap` }); res.end(); return; }
    if (req.method === "POST") {
      writes++;
      let body = ""; for await (const chunk of req) body += chunk;
      if (url.pathname === "/api/profile") name = JSON.parse(body).name;
      res.setHeader("content-type", "application/json"); res.end('{}'); return;
    }
    res.setHeader("content-type", "text/html");
    res.setHeader("Content-Security-Policy", "img-src 'self'");
    if (url.pathname === "/profile") return res.end(shell(`<h1>Profile</h1><label>Display name<input id="name" value="${name}"></label><button type=button onclick="fetch('/api/profile',{method:'POST',body:JSON.stringify({name:document.querySelector('#name').value})}).then(()=>document.querySelector('#status').textContent='Profile saved')">Save</button><p id=status></p>`));
    if (url.pathname === "/login") return res.end(shell('<h1>Sign in</h1><input type=password><form><button>Login</button></form>'));
    if (url.pathname === "/next") { nextRequests++; return res.end(shell('<h1>Next page</h1><a href="/controls">Back</a>')); }
    if (url.pathname === "/hybrid") return res.end(shell('<button type=button onclick="history.pushState({},\'\',\'/intermediate\');history.pushState({},\'\',\'/second\');location.href=\'/next\'">Hybrid navigation</button>'));
    if (url.pathname === "/noisy") return res.end(shell('<button type=button>Silent</button><p id=counter></p><script>setInterval(()=>counter.textContent=Date.now(),40)</script>'));
    if (url.pathname === "/blink") return res.end(shell(`<span id=credits>120</span><script>setTimeout(()=>{credits.textContent='pending';setTimeout(()=>credits.textContent='120',150)},200)</script>`));
    res.end(shell(`<h1>Controls</h1>
      <button type=button id=menu aria-expanded=false onclick="this.setAttribute('aria-expanded','true');document.querySelector('#panel').hidden=false">Account</button>
      <div id=panel hidden><button type=button id=child onclick="document.querySelector('#status').textContent='Child worked'">Details</button></div>
      <button type=button id=silent>Silent</button><button type=button disabled>Disabled</button>
      <button type=button id=write onclick="fetch('/api/write',{method:'POST'})">Touch server</button>
      <a href=/logout>Continue</a><a href=http://127.0.0.1:1/external>Elsewhere</a>
      <form><button>Go</button></form><a href=/next>Next page</a>
      <p id=status></p><div style="height:1000px"></div><button type=button id=bottom onclick="status.textContent='bottom'">Bottom</button>`));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, writes: () => writes, foreignRequests: () => foreignRequests, nextRequests: () => nextRequests };
}
function matrix(home, url, steps, extra = {}) {
  const cfg = { platform: { url, ...extra }, personas: { tester: { name: "Tester" } }, cells: [{ persona: "tester", screens: ["/controls"], journeys: ["acceptance"] }], journeys: { acceptance: { steps } } };
  const file = path.join(home, "matrix.json"); writeFileSync(file, JSON.stringify(cfg)); return file;
}

test("permission and numeric bounds fail closed", () => {
  assert.throws(() => requireInteraction({}), /interact/);
  assert.throws(() => requireInteraction({ interact: true }, true), /allow-writes/);
  for (const n of [0, -1, NaN, Infinity, "x", 201]) assert.throws(() => bounded(n, 40, 200));
  assert.equal(bounded(undefined, 40, 200), 40);
  assert.deepEqual(parseArgs(["--interact", "false", "--allow-writes", "false"]), { interact: false, "allow-writes": false });
  assert.throws(() => requireInteraction(parseArgs(["--interact", "false"])));
  assert.throws(() => parseArgs(["--interact", "banana"]));
  assert.throws(() => tpl("{{partner.name}}", { partner: {} }), /Missing template/);
  assert.throws(() => resolveCells({ cells: [{ persona: "a.b" }, { persona: "a/b" }] }, undefined, true), /slugs must be unique/);
});

test("React sensor visits root siblings and HostRoot deletions", () => {
  const context = vm.createContext({ window: {}, performance: { now: () => 100 }, Map, WeakMap, WeakSet, Set });
  vm.runInContext(`(${REACT_SENSOR.toString()})()`, context);
  const host = () => ({ tag: 5, stateNode: { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) } });
  const Header = function Header() {}, Chat = function Chat() {};
  const a = { tag: 0, type: Header, child: host() }, b = { tag: 0, type: Chat, child: host() }; a.sibling = b;
  context.window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: { tag: 3, child: a } });
  const names = Array.from(context.window.__glReact.events, (e) => e.name);
  assert.ok(names.includes("Header")); assert.ok(names.includes("Chat"));
});

test("text flap uses transient duration and emits once for duplicate mutations", () => {
  let callback, now = 100;
  const el = { tagName: "SPAN", nodeType: 1, id: "credits", className: "", innerText: "A", getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }) };
  const context = vm.createContext({ window: {}, performance: { now: () => now },
    document: { head: { appendChild() {} }, documentElement: {}, createElement: () => ({}), querySelectorAll: () => [], getAnimations: () => [] },
    MutationObserver: class { constructor(cb) { callback = cb; } observe() {} }, PerformanceObserver: class { observe() {} }, setInterval() {}, WeakMap });
  vm.runInContext(`(${DOM_OBSERVER.toString()})()`, context);
  const change = (text, old, t) => { el.innerText = text; now = t; callback([{ type: "characterData", target: { parentElement: el }, oldValue: old }]); };
  change("A", "X", 100); change("B", "A", 3000); change("A", "B", 3120); change("A", "A", 3130);
  const flaps = context.window.__gl.events.filter((e) => e.type === "text-flap");
  assert.equal(flaps.length, 1); assert.equal(flaps[0].visibleMs, 120);
});

test("tool errors cannot reuse stale files and aborted calls do not execute", async () => {
  const tools = new Map(); let called = 0;
  extension({ registerTool: (t) => tools.set(t.name, t), registerCommand() {}, exec: async () => { called++; return { code: 1, stdout: "old index exists", stderr: "failure" }; } });
  const r = await tools.get("glitch_hunt").execute("id", { mode: "loads", url: "http://localhost", out: "old" }, undefined, undefined, { cwd: root });
  assert.equal(r.isError, true); assert.equal(r.details.ok, false);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(tools.get("ux_report").execute("id", { runDir: ".ux" }, ac.signal, undefined, { cwd: root }));
  assert.equal(called, 1);
  await assert.rejects(tools.get("ux_affordance_scan").execute("id", { url: "http://localhost", probeClicks: true, viewport: "--interact" }, undefined, undefined, { cwd: root }), /another CLI flag/);
  assert.equal(called, 1);
});

test("synthetic browser inventory, exploration, UAT, baseline and sensor evidence", { timeout: 180000 }, async (t) => {
  const home = fixture(t), target = await app(t);
  await t.test("observation inventories below-fold controls without clicks or writes", async () => {
    const out = path.join(home, "observe");
    const r = await cli(home, "affordance_scan.mjs", "--url", target.url + "/controls", "--out", out);
    assert.equal(r.code, 0, r.stderr);
    const scan = read(path.join(out, "adhoc/affordance/controls_affordance.json"));
    assert.ok(scan.items.some((i) => i.selector === "#bottom"));
    assert.ok(scan.items.some((i) => i.disabled));
    assert.equal(scan.coverage, null); assert.equal(target.writes(), 0);
    assert.equal((await cli(home, "affordance_scan.mjs", "--url", target.url, "--out", out)).code, 1);
  });
  await t.test("explorer discovers menu states, silent controls and skips destructive/foreign/form targets", async () => {
    const out = path.join(home, "explore");
    const r = await cli(home, "affordance_scan.mjs", "--url", target.url + "/controls", "--probe-clicks", "--interact", "--max-states", "4", "--max-pages", "1", "--max-actions", "18", "--observe-ms", "200", "--seconds", "40", "--out", out);
    assert.equal(r.code, 0, r.stderr);
    const scan = read(path.join(out, "adhoc/affordance/controls_affordance.json"));
    const coverage = scan.coverage;
    assert.ok(coverage.actions.some((a) => a.text === "Account" && a.result === "responded"));
    assert.ok(coverage.actions.some((a) => a.text === "Details" && a.result === "responded"));
    assert.ok(coverage.actions.some((a) => a.text === "Silent" && a.result === "no-observable-response"));
    assert.ok(coverage.actions.some((a) => a.text === "Continue" && a.result === "skipped"));
    assert.ok(coverage.actions.some((a) => a.text === "Elsewhere" && a.result === "skipped"));
    assert.equal(target.writes(), 0);
    assert.equal(target.nextRequests(), 0, "page budget must prevent navigation before dispatch");
    assert.ok(coverage.exercised <= 18);
    assert.ok(coverage.actualClicks <= 18);
    assert.equal(coverage.actualClicks, coverage.exercised + coverage.replays.length);
    assert.equal(existsSync(path.join(home, ".ux/auth")), false);
    const report = path.join(home, "report.html");
    assert.equal((await cli(home, "report.mjs", out, "--embed", "--out", report)).code, 0);
    assert.match(readFileSync(report, "utf8"), /Interaction coverage/);
    assert.match(readFileSync(report, "utf8"), /NOT correct business behavior/);
  });
  await t.test("combined SPA and document navigations share one page budget", async () => {
    const out = path.join(home, "hybrid");
    const before = target.nextRequests();
    const r = await cli(home, "affordance_scan.mjs", "--url", target.url + "/hybrid", "--probe-clicks", "--interact", "--max-pages", "3", "--max-actions", "1", "--observe-ms", "100", "--out", out);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(target.nextRequests(), before);
  });
  await t.test("background polling is not mistaken for a successful button response", async () => {
    const out = path.join(home, "noisy");
    const r = await cli(home, "affordance_scan.mjs", "--url", target.url + "/noisy", "--probe-clicks", "--interact", "--max-actions", "1", "--observe-ms", "200", "--out", out);
    assert.equal(r.code, 0, r.stderr);
    const coverage = read(path.join(out, "adhoc/affordance/noisy_affordance.json")).coverage;
    assert.ok(coverage.actions.some((a) => a.text === "Silent" && a.result === "inconclusive"));
  });
  await t.test("failed and unknown journeys fail, and unapproved writes do not execute", async () => {
    const config = matrix(home, target.url, [{ goto: "/controls", shot: false }, { expectVisible: { selector: "#absent" }, timeout: 200, shot: false }]);
    const r = await cli(home, "journey_runner.mjs", "--config", config, "--all", "--out", path.join(home, "failed"));
    assert.equal(r.code, 1, r.stderr);
    assert.equal(read(path.join(home, "failed/tester__direct/journeys/acceptance/result.json")).passed, false);
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--journey", "absent", "--out", path.join(home, "unknown"))).code, 1);
    matrix(home, target.url, [{ goto: "/profile", shot: false }, { fill: { label: "Display name", value: "Unapproved" }, shot: false }]);
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--interact", "--out", path.join(home, "unapproved"))).code, 1);
    assert.equal(target.writes(), 0);
  });
  await t.test("redirects cannot escape the allowed origin and action-only scripts do not pass", async () => {
    const config = matrix(home, target.url, [{ goto: "/redirect", shot: false }, { expectText: "foreign", timeout: 200, shot: false }]);
    const r = await cli(home, "journey_runner.mjs", "--config", config, "--all", "--out", path.join(home, "redirect"));
    assert.equal(r.code, 1); assert.equal(target.foreignRequests(), 0);
    matrix(home, target.url, [{ goto: "/controls", shot: false }]);
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--out", path.join(home, "no-assert"))).code, 1);
  });
  await t.test("baseline comparisons work under restrictive image CSP and missing baselines fail", async () => {
    const config = matrix(home, target.url, [{ goto: "/profile" }, { expectVisible: { label: "Display name" } }]);
    const baseline = path.join(home, "baseline");
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--baseline", baseline)).code, 0);
    const before = readFileSync(path.join(baseline, "tester__direct/journeys/acceptance/result.json"), "utf8");
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--compare", baseline, "--out", path.join(home, "comparison"))).code, 0);
    assert.equal(readFileSync(path.join(baseline, "tester__direct/journeys/acceptance/result.json"), "utf8"), before);
    const baselineResult = read(path.join(baseline, "tester__direct/journeys/acceptance/result.json"));
    const firstShot = baselineResult.steps.find((s) => s.shot).shot;
    rmSync(path.join(baseline, "tester__direct/journeys/acceptance", firstShot));
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--compare", baseline, "--out", path.join(home, "missing-image"))).code, 2);
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--compare", path.join(home, "missing"), "--out", path.join(home, "missing-compare"))).code, 2);
  });
  await t.test("explicit UAT writes persist after reload and assertions pass", async () => {
    const config = matrix(home, target.url, [{ goto: "/profile", shot: false }, { fill: { label: "Display name", value: "QA User" }, shot: false },
      { click: "Save", shot: false }, { expectText: "Profile saved", shot: false }, { reload: true, shot: false },
      { expectValue: { label: "Display name", value: "QA User" }, shot: false }, { expectCount: { selector: "input", count: 1 }, shot: false }, { expectURL: "/profile", shot: false }]);
    const r = await cli(home, "journey_runner.mjs", "--config", config, "--all", "--interact", "--allow-writes", "--out", path.join(home, "passed"));
    assert.equal(r.code, 0, r.stderr + r.stdout); assert.equal(target.writes(), 1);
  });
  await t.test("same-directory comparison and invalid login proofs fail before changing evidence", async () => {
    const config = matrix(home, target.url, [{ goto: "/profile", shot: false }]);
    const r = await cli(home, "journey_runner.mjs", "--config", config, "--all", "--compare", "same", "--out", "same");
    assert.equal(r.code, 1); assert.equal(existsSync(path.join(home, "same")), false);
    matrix(home, target.url, [{ goto: "/profile", shot: false }], { login: { url: "/login", waitFor: "/" } });
    assert.equal((await cli(home, "journey_runner.mjs", "--config", config, "--all", "--interact", "--allow-writes", "--out", path.join(home, "bad-auth"))).code, 1);
  });
  await t.test("failed positive authentication is never cached or accepted", async () => {
    const config = matrix(home, target.url, [{ goto: "/profile", shot: false }, { expectText: "Profile", shot: false }], { login: { url: "/login", submit: "button", authenticated: "#account", timeout: 200 } });
    const r = await cli(home, "journey_runner.mjs", "--config", config, "--all", "--interact", "--allow-writes", "--out", path.join(home, "failed-login"));
    assert.equal(r.code, 1); assert.equal(existsSync(path.join(home, ".ux/auth")), false);
  });
  await t.test("hard-navigation glitches preserve DOM events and produce sampled evidence", async () => {
    const config = matrix(home, target.url, [{ goto: "/controls" }, { goto: "/blink" }]);
    const out = path.join(home, "glitches");
    const r = await cli(home, "glitch_lab.mjs", "journey", "--config", config, "--all", "--journey", "acceptance", "--interact", "--repeat", "1", "--cpu", "1", "--out", out, "--watch-ms", "600");
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const files = readdirSync(path.join(out, "tester__direct")).filter((f) => f.endsWith("_r1.json"));
    assert.ok(files.length === 2);
    const findings = files.flatMap((f) => read(path.join(out, "tester__direct", f)).glitches);
    assert.ok(findings.some((g) => g.type === "text-flap"));
    assert.ok(findings.filter((g) => g.type === "text-flap").every((g) => g.image && existsSync(path.join(out, "tester__direct", g.image))));
  });
  await t.test("real bundled React app exposes repeated ChatBox remounts", async () => {
    const { chromium } = await loadPlaywright(), browser = await launchBrowser(chromium);
    try {
      const context = await browser.newContext(); await context.addInitScript(REACT_SENSOR); await context.addInitScript(DOM_OBSERVER);
      const page = await context.newPage(); await page.goto(target.url + "/react");
      await page.getByRole("link", { name: "Chat", exact: true }).click();
      await page.waitForFunction(() => window.__glReact?.events.some((e) => e.type === "remount" && e.name === "ChatBox"), undefined, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__glReact.available), true);
    } finally { await browser.close(); }
  });
  await t.test("DOM-only analysis supplies evidence even without a visible sampled transient", async () => {
    const { chromium } = await loadPlaywright(), browser = await launchBrowser(chromium);
    try {
      const page = await browser.newPage(); await page.setContent("<p>stable</p>");
      const data = (await page.screenshot()).toString("base64");
      const res = await analyzeScenario({ helper: page, frames: [{ data, t: 0 }, { data, t: 200 }], dom: { events: [{ type: "text-flap", t: 100, visibleMs: 30, rect: { x: 0, y: 0, w: 50, h: 30 } }], shifts: [] }, viewport: { width: 1280, height: 720 }, ignoreRects: [], kind: "interaction", dir: home, name: "dom-only" });
      assert.ok(res.glitches[0].image); assert.match(res.glitches[0].note, /may not have been captured/);
    } finally { await browser.close(); }
  });
});
