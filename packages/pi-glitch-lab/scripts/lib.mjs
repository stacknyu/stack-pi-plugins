// Shared helpers for affordance_scan.mjs and journey_runner.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) out[k] = true;
    else { out[k] = v; i++; }
    if (["interact", "allow-writes", "probe-clicks", "all", "paint", "embed", "headed"].includes(k)) {
      if (![true, "true", "false"].includes(out[k])) throw new Error(`--${k} must be true or false`);
      out[k] = out[k] === true || out[k] === "true";
    }
  }
  return out;
}

export async function loadPlaywright() {
  try { return await import("playwright"); } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const req = createRequire(path.join(root, "noop.js"));
    return req("playwright");
  } catch {}
  console.error("Playwright not found. Install: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

/** Launch Chromium; falls back to installed Google Chrome if Playwright's browser isn't downloaded. */
export async function launchBrowser(chromium, args = {}) {
  const opts = { headless: !args.headed };
  const channel = args.channel || process.env.GLITCH_LAB_CHANNEL;
  try {
    return await chromium.launch(channel ? { ...opts, channel } : opts);
  } catch (e) {
    if (!channel) { try { return await chromium.launch({ ...opts, channel: "chrome" }); } catch {} }
    throw new Error("Could not launch a browser. Run `npx playwright install chromium` in the package folder, or pass --channel chrome. " + String(e.message).split("\n")[0]);
  }
}

export function loadConfig(p) {
  if (!p || !fs.existsSync(p)) {
    console.error(`Config not found: ${p}. Start from assets/matrix.example.json`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
  android: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },   // typical Indian mid-range Android
  iphone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  laptop: { viewport: { width: 1366, height: 768 } },                                                        // common budget laptop / Chromebook
  "laptop-zoom125": { viewport: { width: 1093, height: 614 }, deviceScaleFactor: 1.25 },                     // 1366×768 at 125% browser zoom
  "desktop-zoom150": { viewport: { width: 960, height: 600 }, deviceScaleFactor: 1.5 },                      // 1440×900 at 150% browser zoom
};
export const NETWORKS = {
  fast: null,
  fast3g: { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  slow3g: { offline: false, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8, latency: 400 },
};

/**
 * Resolve cells into full objects with merged settings.
 * A cell without "partner" (or partner "direct") tests the platform directly, as a root user
 * with no partner; it uses cfg.platform for name/url.
 */
export function resolveCells(cfg, cellArg, all) {
  const cells = (cfg.cells || []).map((c) => ({ ...c, partner: c.partner || "direct" }));
  const ids = cells.map((c) => `${c.persona}@${c.partner}`), slugs = cells.map((c) => `${c.persona}__${c.partner}`.replace(/[^a-z0-9_-]+/gi, "_"));
  if (new Set(ids).size !== ids.length || new Set(slugs).size !== slugs.length) throw new Error("Cell identities/output slugs must be unique");
  const key = (c) => `${c.persona}@${c.partner}`;
  const want = cellArg && !String(cellArg).includes("@") ? `${cellArg}@direct` : cellArg;
  const pick = all ? cells : cells.filter((c) => key(c) === want);
  if (!pick.length) {
    console.error(`No cell matches "${cellArg}". Available: ${cells.map(key).join(", ")}`);
    process.exit(1);
  }
  return pick.map((c) => {
    const screens = c.screens || [];
    if (new Set(screens.map(slugify)).size !== screens.length) throw new Error("Screen output names collide; split into separate cells/runs");
    const persona = cfg.personas?.[c.persona] || {};
    const direct = c.partner === "direct";
    const partner = direct ? { name: cfg.platform?.name || "", url: cfg.platform?.url, direct: true } : cfg.partners?.[c.partner] || {};
    const base = (c.baseUrl || partner.url || cfg.platform?.url || cfg.baseUrl || "").replace(/\/$/, "");
    return {
      ...c,
      id: key(c),
      slug: `${c.persona}__${c.partner}`.replace(/[^a-z0-9_-]+/gi, "_"),
      persona, partner, base,
      viewport: c.viewport || persona.viewport || "desktop",
      network: c.network || persona.network || "fast",
      locale: c.locale || persona.locale,
      timezone: c.timezone || persona.timezone,
      login: c.login || (direct ? cfg.platform?.login : partner.login) || c.login,
      unsafe: [...(cfg.unsafeWords || []), ...(partner.unsafeWords || [])],
      mask: [...(cfg.mask || []), ...(c.mask || [])],
    };
  });
}

/** Find an element the way a user would: by visible text/role, label, placeholder, or selector. */
export function locatorFor(page, spec, cell) {
  if (typeof spec === "string") {
    const t = tpl(spec, cell);
    return page.getByRole("button", { name: t, exact: true })
      .or(page.getByRole("link", { name: t, exact: true }))
      .or(page.getByRole("tab", { name: t, exact: true }))
      .or(page.getByRole("menuitem", { name: t, exact: true }));
  }
  if (spec.selector) return page.locator(spec.selector);
  if (spec.role) return page.getByRole(spec.role, { name: tpl(spec.name, cell), exact: true });
  if (spec.label) return page.getByLabel(tpl(spec.label, cell), { exact: true });
  if (spec.placeholder) return page.getByPlaceholder(tpl(spec.placeholder, cell), { exact: true });
  if (spec.text) return page.getByText(tpl(spec.text, cell), { exact: true });
  throw new Error("Unknown target " + JSON.stringify(spec));
}

/** Fill {{partner.name}}, {{persona.name}} etc. */
export function tpl(str, cell) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*(partner|persona)\.(\w+)\s*\}\}/g, (_, o, k) => {
    const value = cell[o]?.[k];
    if (value === undefined || value === null || String(value).trim() === "") throw new Error(`Missing template value: ${o}.${k}`);
    return value;
  });
}

export async function newContext(browser, cell, args = {}) {
  const opts = { ...(VIEWPORTS[cell.viewport] || VIEWPORTS.desktop), serviceWorkers: "block" };
  if (cell.locale) opts.locale = cell.locale;
  if (cell.timezone) opts.timezoneId = cell.timezone;
  const context = await browser.newContext(opts);
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(30000);
  await protectContext(context, cell, args);
  return context;
}

export const UNSAFE = /delete|remove|pay|purchase|buy|billing|send|submit|logout|log.out|sign.out|upgrade|subscribe|invite|publish|deactivate|reset/i;
export function requireInteraction(args, writes = false) {
  if (args.interact !== true) throw new Error("Interaction requires --interact: authorize a disposable test environment first");
  if (writes && args["allow-writes"] !== true) throw new Error("This action requires explicit --allow-writes authorization");
}

export async function protectContext(context, cell, args) {
  if (args["allow-writes"]) requireInteraction(args);
  const origins = new Set([new URL(cell.base).origin, ...(cell.allowedOrigins || []).map((u) => new URL(u).origin)]);
  context._uxArgs = args;
  context._uxBlocked = [];
  await context.exposeBinding("__uxHistoryVisit", (_source, url) => { context._uxPageBudget?.urls.add(url); });
  await context.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method());
    const budget = context._uxPageBudget;
    if (req.isNavigationRequest() && budget) {
      // Never evaluate in a frame paused for navigation: it waits for this route and deadlocks.
      const prior = req.frame().url();
      if (prior && prior !== "about:blank") budget.urls.add(prior);
    }
    const overBudget = req.isNavigationRequest() && budget && !budget.urls.has(req.url()) && budget.urls.size >= budget.limit;
    if (overBudget) budget.hit = true;
    const denied = overBudget || (req.isNavigationRequest() && !origins.has(url.origin)) ||
      (write && (!args["allow-writes"] || !origins.has(url.origin))) ||
      (!args["allow-writes"] && UNSAFE.test(url.pathname));
    if (denied) {
      context._uxBlocked.push({ method: req.method(), url: url.origin + url.pathname });
      await route.abort("blockedbyclient");
    } else if (req.isNavigationRequest() || write) {
      if (req.isNavigationRequest() && budget) budget.urls.add(req.url());
      // Route handlers do not re-check a browser redirect chain. Fail closed before following it.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          context._uxBlocked.push({ method: req.method(), url: url.origin + url.pathname, reason: "HTTP redirect requires a direct target URL" });
          await route.abort("blockedbyclient");
        } else await route.fulfill({ response });
      } catch (e) {
        context._uxBlocked.push({ method: req.method(), url: url.origin + url.pathname, reason: e.message });
        await route.abort("failed").catch(() => {});
      }
    } else await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url()), origin = url.origin.replace(/^ws/, "http");
    if (args["allow-writes"] === true && origins.has(origin)) socket.connectToServer();
    else { context._uxBlocked.push({ method: "WEBSOCKET", url: origin + url.pathname }); socket.close(); }
  });
}

export async function checkTarget(loc, cell, args, automatic = false) {
  requireInteraction(args);
  const target = await loc.evaluate((el) => ({ text: [el.textContent, el.getAttribute("aria-label"), el.getAttribute("href")].join(" "),
    href: el.closest("a[href]")?.href, submit: el.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]') && !!el.closest("form") }));
  if (target.href) {
    const url = new URL(target.href);
    if (![new URL(cell.base).origin, ...(cell.allowedOrigins || []).map((u) => new URL(u).origin)].includes(url.origin)) throw new Error("Destination origin is not allowed");
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Non-web destination skipped");
  }
  const unsafe = UNSAFE.test(target.text) || (cell.unsafe || []).some((w) => target.text.toLowerCase().includes(w.toLowerCase()));
  if ((target.submit || unsafe) && (automatic || !args["allow-writes"])) throw new Error("Potential write/destructive control skipped; use an explicitly authorized journey");
}

export function freshOutput(dir) {
  fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  fs.mkdirSync(dir); // never overwrite a prior run or baseline
}

export function bounded(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Expected integer between 1 and ${max}`);
  return n;
}

export async function throttle(context, page, cell) {
  const n = NETWORKS[cell.network];
  if (!n) return;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", n);
  } catch { /* non-chromium */ }
}

export async function login(context, cell) {
  const l = cell.login;
  if (!l) return;
  requireInteraction(context._uxArgs || {}, true);
  if (!l.authenticated && (!l.waitFor || l.waitFor === "/")) throw new Error("Login needs an authenticated selector or a specific waitFor pathname (not /)");
  const page = await context.newPage();
  const timeout = bounded(l.timeout, 15000, 30000);
  await page.goto(cell.base + tpl(l.url, cell), { waitUntil: "domcontentloaded" });
  for (const [sel, val] of Object.entries(l.fields || {})) {
    const v = String(val).startsWith("env:") ? process.env[String(val).slice(4)] : String(val);
    if (!v) throw new Error(`Missing login value for ${sel}`);
    await page.fill(sel, v);
  }
  await page.click(l.submit || "button[type=submit]");
  if (l.waitFor) await page.waitForURL((u) => u.origin === new URL(cell.base).origin && u.pathname === l.waitFor, { timeout });
  if (l.authenticated) await page.locator(l.authenticated).waitFor({ state: "visible", timeout });
  await page.close();
}

export function attachListeners(page, sink) {
  page.on("console", (m) => { if (m.type() === "error") sink.console.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => sink.console.push("pageerror: " + e.message.slice(0, 300)));
  page.on("requestfailed", (r) => sink.failed.push({ url: r.url().slice(0, 200), error: r.failure()?.errorText }));
  page.on("response", (r) => { if (r.status() >= 400) sink.failed.push({ url: r.url().slice(0, 200), status: r.status() }); });
}

export const slugify = (s) => (s === "/" ? "home" : String(s).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60) || "page");
export const ensureDir = (d) => (fs.mkdirSync(d, { recursive: true }), d);
