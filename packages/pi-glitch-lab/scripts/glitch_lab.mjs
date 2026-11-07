#!/usr/bin/env node
/**
 * glitch_lab.mjs — find subtle visual glitches the way a QA engineer would, but with sensors.
 *
 * Modes
 *   nav      click through the app's navigation (sidebar/header links) and watch every page-to-page transition
 *   loads    open each screen from scratch and watch it load
 *   journey  run a scripted journey (e.g. open chat, send a message) and watch after every action
 *   idle     sit on each screen without touching anything (catches polling/refresh glitches, e.g. a chat box rebuilding itself)
 *
 * Examples
 *   node glitch_lab.mjs nav --url http://localhost:3000/dashboard --out .ux/glitch
 *   node glitch_lab.mjs nav --config .ux/matrix.json --cell indian-germany-student --mode full --repeat 3
 *   node glitch_lab.mjs journey --config .ux/matrix.json --cell us-ivy-applicant --journey emily-plan
 *   node glitch_lab.mjs idle --url http://localhost:3000/chat --idle-ms 8000
 *
 * Options
 *   --repeat N        repeat every scenario N times (default 2); real glitches repeat, noise doesn't
 *   --cpu N           CPU slowdown factor (default 4); stretches 30ms blinks into visible, detectable ones
 *   --after-ms N      how long to watch after each action (default 2500); --watch-ms for page loads (default 5000)
 *   --mode ring|full  nav: ring = A→B→C→…→A, full = every ordered pair (capped by --max-transitions, default 20)
 *   --items "Chat,Notes"   nav: use these link texts instead of auto-discovering nav links
 *   --paint           also record a video with Chrome's paint-flashing + layout-shift overlays
 *   --viewport, --network, --channel chrome, --headed, --grid 24
 *
 * Sensors (all at once): every painted frame (Chrome screencast), React commits (which component mounted,
 * re-rendered, was removed, remounted; which props changed), DOM mutations (element rebuilds, text flaps),
 * layout shifts, running animations, network responses.
 *
 * Output (per cell, under --out): findings.json, summary.md (short, for the agent), evidence images, raw data.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, loadPlaywright, launchBrowser, loadConfig, resolveCells, newContext, login, throttle,
         attachListeners, slugify, ensureDir, tpl, VIEWPORTS, locatorFor, freshOutput, requireInteraction, checkTarget, protectContext, bounded } from "./lib.mjs";
import { DOM_OBSERVER } from "./sensors/dom_observer.mjs";
import { REACT_SENSOR } from "./sensors/react_sensor.mjs";
import { analyzeScenario, record, ignoreRectsFor, composite, overlapFrac, regionChange } from "./glitch/analyze.mjs";

const mode = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "nav";
const args = parseArgs(process.argv.slice(mode === process.argv[2] ? 3 : 2));
const OUT = args.out || ".ux/glitch";
freshOutput(OUT);
if (["nav", "journey"].includes(mode)) requireInteraction(args);
const REPEAT = bounded(args.repeat, 2, 5);
const CPU = bounded(args.cpu, 4, 10);
const AFTER_MS = Number(args["after-ms"] || 2500);
const WATCH_MS = Number(args["watch-ms"] || 5000);
const IDLE_MS = bounded(args["idle-ms"], 8000, 60000);
const GRID = Number(args.grid || 24);
const MAX_T = bounded(args["max-transitions"], 20, 50);
const MAX_ITEMS = bounded(args["max-items"], 8, 20);
const DEFAULT_UNSAFE = ["logout", "log out", "sign out", "delete", "remove", "pay", "billing", "upgrade", "subscribe", "deactivate"];

const FRAMEWORK = new Set(["InnerLayoutRouter", "OuterLayoutRouter", "LayoutRouter", "RenderFromTemplateContext", "ScrollAndFocusHandler",
  "InnerScrollAndFocusHandler", "RedirectBoundary", "RedirectErrorBoundary", "NotFoundBoundary", "NotFoundErrorBoundary", "LoadingBoundary",
  "ErrorBoundary", "ErrorBoundaryHandler", "HTTPAccessFallbackBoundary", "HTTPAccessFallbackErrorBoundary", "Router", "AppRouter", "HotReload",
  "ServerRoot", "Root", "ReactDevOverlay", "PathnameContextProviderAdapter", "SegmentViewNode", "ClientPageRoot", "ClientSegmentRoot",
  "MetadataBoundary", "ViewportBoundary", "OutletBoundary", "AsyncMetadata", "Head", "Suspense", "Fragment", "StrictMode", "Provider",
  "Link", "LinkComponent", "Image", "Script"]);

const { chromium } = await loadPlaywright();

// ---------------- cells ----------------
let cfg = {}, cells;
if (args.url) {
  const u = new URL(args.url);
  cells = [{ id: "adhoc", slug: "adhoc", base: u.origin, start: u.pathname + u.search, screens: [u.pathname + u.search],
    viewport: args.viewport || "desktop", network: args.network || "fast", unsafe: [], persona: {}, partner: {}, mask: [] }];
} else {
  cfg = loadConfig(args.config);
  cells = resolveCells(cfg, args.cell, args.all);
}

// ---------------- helpers ----------------
const discoverNav = (unsafe) => {
  const sels = "nav a[href], aside a[href], [role=navigation] a[href], header a[href], [data-sidebar] a[href]";
  const seen = new Set(), out = [];
  for (const a of document.querySelectorAll(sels)) {
    let u; try { u = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (u.origin !== location.origin || a.getAttribute("href").startsWith("#")) continue;
    const r = a.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const text = (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (unsafe.some((w) => (text + " " + u.pathname).toLowerCase().includes(w))) continue;
    const key = u.pathname + u.search; if (seen.has(key)) continue; seen.add(key);
    out.push({ href: a.getAttribute("href"), path: key, text });
  }
  return out;
};
const here = (page) => { try { const u = new URL(page.url()); return u.pathname + u.search; } catch { return ""; } };
async function clickItem(page, item, cell) {
  if (item.href) {
    const loc = page.locator(`a[href="${item.href.replace(/"/g, '\\"')}"]`).filter({ visible: true }).first();
    if (await loc.count()) { await checkTarget(loc, cell, args, true); return loc.click({ timeout: 10000 }); }
  }
  const loc = locatorFor(page, item.text || item.label, cell);
  await checkTarget(loc, cell, args, true);
  return loc.click({ timeout: 10000 });
}
async function prepPage(context, page, cell) {
  await throttle(context, page, cell);
  const cdp = await context.newCDPSession(page); // keep attached: emulation lasts as long as the session
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU }).catch(() => {});
  page._glCdp = cdp;
  const net = [];
  page.on("response", (r) => { try { const u = new URL(r.url()); if (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|css|ico)$/i.test(u.pathname)) return;
    net.push({ wall: Date.now(), method: r.request().method(), path: (u.pathname + u.search).slice(0, 80), status: r.status() }); } catch {} });
  page._glNet = net;
}
const resetSensors = (page) => page.evaluate(() => {
  if (window.__gl) { window.__gl.events = []; window.__gl.shifts = []; }
  if (window.__glReact) window.__glReact.events = [];
  return performance.timeOrigin + performance.now();
}).catch(() => 0);
const readSensors = (page) => page.evaluate(() => ({
  timeOrigin: performance.timeOrigin,
  dom: window.__gl ? { events: window.__gl.events, shifts: window.__gl.shifts, anim: window.__gl.anim } : { events: [], shifts: [], anim: [] },
  react: window.__glReact ? { available: window.__glReact.available, events: window.__glReact.events.slice(-4000), commits: window.__glReact.commits, error: window.__glReact.error, dropped: window.__glReact.dropped } : { available: false, events: [] },
}));

function rebase(sensors, perf0) {
  const sh = (e) => ({ ...e, t: Math.round(sensors.timeOrigin + e.t - perf0) });
  return {
    dom: { events: sensors.dom.events.map(sh).filter((e) => e.t >= -50), shifts: sensors.dom.shifts.map(sh).filter((e) => e.t >= -50), anim: sensors.dom.anim.map(sh) },
    react: { ...sensors.react, events: sensors.react.events.map(sh).filter((e) => e.t >= -50) },
  };
}

/** Record one scenario: run `act`, watch, analyze, correlate. */
async function runScenario({ page, cell, dir, helper, name, label, kind, act, watchMs, rep, targetRectFn }) {
  const perf0 = await resetSensors(page);
  const netStart = page._glNet.length;
  const startWall = Date.now();
  let err = null;
  const frames = await record(page, async () => { try { await act(); } catch (e) { err = String(e.message).split("\n")[0]; } }, watchMs);
  const sensors = rebase(await readSensors(page), perf0 || startWall);
  if (!frames.length) err ||= "No painted frames captured; visual coverage unavailable";
  const vp = page.viewportSize();
  const targetRect = targetRectFn ? await targetRectFn() : null;
  const res = await analyzeScenario({ helper, frames, dom: sensors.dom, viewport: vp, ignoreRects: await ignoreRectsFor(page, cell),
    kind: kind === "load" ? "load" : "interaction", targetRect, dir, name: `${name}_r${rep}`, grid: GRID });
  for (const g of res.glitches) if (g.type === "remount") g.type = "remount-dom"; // DOM-level rebuild (React ones come from the React sensor)
  const net = page._glNet.slice(netStart).map((n) => ({ ...n, t: n.wall - startWall }));
  const rx = sensors.react.events;
  const valid = res._valid || [];
  const frameAt = (t) => { let best = valid[0]; for (const i of valid) if (frames[i].t <= t) best = i; return best; };
  const firstIdx = valid[0], lastIdx = valid[valid.length - 1];

  // React-derived findings
  const reactFindings = [];
  const remounts = rx.filter((e) => e.type === "remount");
  for (const e of remounts) {
    const change = e.rect && firstIdx !== undefined ? regionChange(res, frameAt(e.t - 20), lastIdx, e.rect, GRID) : null;
    const sameLook = change !== null && change < 0.25;
    reactFindings.push({ type: "remount", source: "react", t: e.t, name: e.name, css: e.rect, gapMs: e.gapMs,
      framework: FRAMEWORK.has(e.name), regionChanged: change === null ? null : +change.toFixed(2),
      note: sameLook ? "rebuilt although it looks the same before and after (persistent UI being thrown away)" :
        change === null ? "" : "its area changed, so this may be expected (content replaced)" });
  }
  // render storms: many renders of the same component within this scenario
  const renders = {};
  for (const e of rx.filter((e) => e.type === "render")) {
    const r = (renders[e.name] ||= { n: 0, changed: {}, rect: e.rect, t: e.t });
    r.n++; for (const c of e.changed || []) r.changed[c] = (r.changed[c] || 0) + 1;
  }
  for (const [nm, r] of Object.entries(renders)) {
    if (r.n >= 4 && !FRAMEWORK.has(nm)) reactFindings.push({ type: "render-storm", source: "react", t: r.t, name: nm, css: r.rect, count: r.n,
      changed: Object.entries(r.changed).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`) });
  }
  // correlate every glitch with components and network
  const all = [...res.glitches, ...reactFindings];
  for (const g of all) {
    if (g.source !== "react" && g.css) {
      const near = rx.filter((e) => e.rect && Math.abs(e.t - g.t) <= 300 && overlapFrac(e.rect, g.css) > 0.2 && e.type !== "unmount");
      const vpArea = vp.width * vp.height;
      // several components can share one DOM element (wrappers); keep the one closest to the element
      const byEl = new Map();
      for (const e of near) { const kk = `${e.rect.x},${e.rect.y},${e.rect.w},${e.rect.h}`; const cur = byEl.get(kk); if (!cur || (e.rect.d ?? 99) < (cur.rect.d ?? 99)) byEl.set(kk, e); }
      near.length = 0; near.push(...byEl.values());
      near.sort((x, y) => x.rect.w * x.rect.h - y.rect.w * y.rect.h);
      const specific = near.filter((e) => e.rect.w * e.rect.h < 0.4 * vpArea && !FRAMEWORK.has(e.name));
      const comps = {};
      for (const e of specific.length ? specific : near) { const k = `${e.type}:${e.name}`; comps[k] ||= { type: e.type, name: e.name, changed: e.changed }; }
      g.components = Object.values(comps).slice(0, 3);
    }
    g.network = net.filter((n) => n.t >= g.t - 450 && n.t <= g.t + 60).map((n) => `${n.method} ${n.path} ${n.status} (+${n.t}ms)`).slice(0, 3);
  }
  // evidence images for react findings (before/after frames with the component boxed)
  let k = 0;
  for (const g of reactFindings) {
    if (!g.css || firstIdx === undefined || k >= 6) continue;
    const b = frameAt(g.t - 20), a = frameAt(g.t + 250);
    const box = { x: g.css.x / res.imgToCss, y: g.css.y / res.imgToCss, w: g.css.w / res.imgToCss, h: g.css.h / res.imgToCss };
    g.image = `${name}_r${rep}_react_${String(++k).padStart(2, "0")}.png`;
    await composite(helper, [{ data: frames[b].data, label: `before · ${frames[b].t} ms`, boxes: [box] },
      { data: frames[a].data, label: `after · ${frames[a].t} ms`, boxes: [box] }], path.join(dir, g.image), { thumbW: 380 });
  }
  const out = { scenario: name, label, kind, rep, error: err, frames: res.frames, settledAtMs: res.settledAtMs, cls: res.cls,
    react: { available: sensors.react.available, commits: sensors.react.commits, events: rx.length, error: sensors.react.error },
    glitches: all, renders: Object.fromEntries(Object.entries(renders).sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([n, r]) => [n, r.n])),
    network: net.slice(0, 30) };
  fs.writeFileSync(path.join(dir, `${name}_r${rep}.json`), JSON.stringify(out, null, 1));
  return out;
}

// ---------------- scoring & aggregation ----------------
const bucket = (r) => (r ? `${Math.round(r.x / 80)},${Math.round(r.y / 80)},${Math.round(r.w / 160)},${Math.round(r.h / 160)}` : "-");
function describe(g) {
  switch (g.type) {
    case "remount": return g.framework ? `${g.name} (framework) is rebuilt` : `${g.name} is thrown away and rebuilt`;
    case "render-storm": return `${g.name} re-renders ${g.count}× (changed: ${(g.changed || []).join(", ") || "?"})`;
    case "flicker": return `${g.components?.length ? g.components[0].name + " area" : "a region"} blinks for ${g.visibleMs}ms${g.components?.length > 1 ? ` (also: ${g.components.slice(1).map((c) => c.name).join(", ")})` : !g.components?.length && g.likelyElements?.length ? ` (${g.likelyElements[0]})` : ""}`;
    case "text-flap": return `text changes and changes back: ${(g.sequence || []).map((s) => `“${String(s).replace(/\s+/g, " ").trim().slice(0, 40) || "(empty)"}”`).join(" → ")}`;
    case "late-change": return `part of the page changes after it looked finished${g.components?.length ? ` (${g.components.map((c) => c.name).join(", ")})` : ""}`;
    case "layout-shift": return `content jumps (shift ${g.value})${g.sources?.[0]?.desc ? `: ${g.sources[0].desc}` : ""}`;
    case "remount-dom": return `element rebuilt: ${g.desc}`;
    default: return `${g.type}${g.desc ? ": " + g.desc : ""}`;
  }
}
function score(f, totalRuns) {
  const g = f.example;
  let s = { "remount": 4, "flicker": 4, "text-flap": 3, "late-change": 2.5, "layout-shift": 2, "render-storm": 1.5, "remount-dom": 2 }[f.type] ?? 1;
  if (f.type === "remount") { if (g.framework) s -= 3; if (g.regionChanged !== null && g.regionChanged < 0.25) s += 2; if (g.regionChanged !== null && g.regionChanged >= 0.25) s -= 3.5; }
  if (f.type === "flicker") s += Math.min(2, (g.areaPct || 0) / 5) + (g.visibleMs >= 100 ? 1 : 0) - (g.probablyIntentional ? 4 : 0);
  if (f.type === "layout-shift") s += Math.min(3, (g.value || 0) * 30);
  if (f.type === "render-storm") s += Math.min(2, (g.count || 0) / 10);
  s += Math.min(2, (f.runs.size / totalRuns) * 2);          // repeats reliably
  s += Math.min(1.5, (f.scenarios.size - 1) * 0.5);          // happens in many places
  if (f.visibleToo && !(f.type === "remount" && g.regionChanged >= 0.25)) s += 1.5; // a React event that also produced a visible blink
  return +s.toFixed(1);
}
function aggregate(results) {
  const map = new Map();
  const runs = new Set(results.map((r) => r.rep));
  for (const r of results) for (const g of r.glitches) {
    if (g.probablyIntentional) continue;
    const reactType = g.type === "remount" || g.type === "render-storm";
    const who = g.name || (g.components?.[0]?.name) || (g.likelyElements?.[0]?.split(":").slice(1).join(":").trim()) || g.desc || "";
    const key = reactType ? `${g.type}|${who}` : `${g.type}|${bucket(g.css)}`;
    const f = map.get(key) || { key, type: g.type, who, example: g, scenarios: new Set(), runs: new Set(), occurrences: 0, images: [], network: new Set(), visibleToo: false, names: {} };
    f.occurrences++; f.scenarios.add(r.label); f.runs.add(r.rep);
    for (const c of g.components || []) f.names[c.name] = (f.names[c.name] || 0) + 1;
    if (g.image && f.images.length < 3) f.images.push(g.image);
    for (const n of g.network || []) if (f.network.size < 3) f.network.add(n.replace(/ \(\+-?\d+ms\)$/, ""));
    map.set(key, f);
  }
  // mark React remounts/storms that coincide with a visible blink in the same scenario
  for (const r of results) for (const g of r.glitches) if (g.type === "flicker" || g.type === "late-change") for (const c of g.components || []) {
    for (const f of map.values()) if ((f.type === "remount" || f.type === "render-storm") && f.who === c.name) f.visibleToo = true;
  }
  for (const f of map.values()) {
    const top = Object.entries(f.names).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    if (top.length) { f.who = top[0]; f.example = { ...f.example, components: top.slice(0, 3).map((n) => ({ name: n })) }; }
  }
  const list = [...map.values()].map((f) => ({ ...f, score: score(f, runs.size) }));
  list.sort((a, b) => b.score - a.score);
  return list.map((f, i) => ({
    id: `G-${String(i + 1).padStart(2, "0")}`,
    level: f.score >= 7 ? "high" : f.score >= 4.5 ? "medium" : "low",
    score: f.score, type: f.type, what: describe(f.example), component: f.who || null,
    seen: `${f.occurrences}× in ${f.scenarios.size} scenario(s), ${f.runs.size}/${runs.size} runs`,
    scenarios: [...f.scenarios].slice(0, 8), visibleBlink: f.visibleToo || f.type === "flicker",
    region: f.example.css || null, why: f.example.changed || f.example.components?.find((c) => c.changed)?.changed || null,
    note: f.example.note || null, network: [...f.network], images: f.images,
  }));
}
function summaryMd(cell, findings, meta) {
  const L = [];
  L.push(`# Glitch Lab — ${cell.id} · ${meta.mode} · ${meta.scenarios} scenarios × ${REPEAT} runs · CPU ${CPU}× · ${cell.viewport}`);
  L.push(meta.react ? `React sensor: on (${meta.commits} commits observed)` : `React sensor: no React detected (visual + DOM sensors only)`);
  if (meta.errors.length) L.push(`Errors: ${meta.errors.slice(0, 3).join(" | ")}`);
  const names = findings.map((f) => f.component).filter(Boolean);
  if (names.length >= 2 && names.filter((n) => n.length <= 2).length / names.length >= 0.5)
    L.push(`Note: component names look minified (production build). Describe components by their screen area (e.g. "the sidebar"), not by these names; a staging build with readable names would identify them.`);
  const show = findings.filter((f) => f.level !== "low").slice(0, 15);
  L.push(`\n## Findings (${findings.length} total, ${show.length} high/medium shown)`);
  for (const f of show) {
    L.push(`\n**${f.id} [${f.level.toUpperCase()}] ${f.what}** — ${f.seen}${f.visibleBlink ? " · visible blink" : ""}`);
    if (f.note) L.push(`- ${f.note}`);
    if (f.why) L.push(`- why it rendered: ${[].concat(f.why).join(", ")}`);
    if (f.network.length) L.push(`- right after: ${f.network.join("; ")}`);
    L.push(`- where: ${f.scenarios.slice(0, 4).join("; ")}${f.region ? ` · region x${f.region.x} y${f.region.y} ${f.region.w}×${f.region.h}` : ""}`);
    if (f.images.length) L.push(`- evidence: ${f.images.map((i) => path.join(meta.dir, i)).join(" , ")}`);
    if (f.paintImage) L.push(`- repaint frames (green = repainted${f.repaintedPct != null ? `, up to ${f.repaintedPct}% of this area repainted` : ""}): ${path.join(meta.dir, f.paintImage)}`);
  }
  const low = findings.filter((f) => f.level === "low");
  if (low.length) L.push(`\n${low.length} low-priority item(s) in findings.json (framework internals, one-off events, minor shifts).`);
  if (meta.renders.length) L.push(`\nMost re-rendered components: ${meta.renders.slice(0, 8).map(([n, c]) => `${n} ${c}`).join(", ")}`);
  if (meta.paint) L.push(`\nPaint-flashing video: ${meta.paint}`);
  L.push(`\nFull data: ${path.join(meta.dir, "findings.json")}`);
  return L.join("\n");
}

// ---------------- paint-flashing video pass ----------------
async function paintPass(browser, cell, scenarios, dir, storageState) {
  const vp = (VIEWPORTS[cell.viewport] || VIEWPORTS.desktop);
  const vdir = ensureDir(path.join(dir, "paint"));
  const context = await browser.newContext({ ...vp, serviceWorkers: "block", recordVideo: { dir: vdir, size: vp.viewport }, storageState });
  await protectContext(context, cell, args);
  const page = await context.newPage();
  const t0 = Date.now(); // the video starts with the page
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable").catch(() => {}); await cdp.send("Overlay.enable").catch(() => {});
  await cdp.send("Overlay.setShowPaintRects", { result: true }).catch(() => {});
  await cdp.send("Overlay.setShowLayoutShiftRegions", { result: true }).catch(() => {});
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU }).catch(() => {});
  const timeline = [];
  for (const s of scenarios) {
    // a 14px magenta square flashed for ~150ms marks the exact moment of the action in the video
    const mark = async () => {
      timeline.push({ at: +((Date.now() - t0) / 1000).toFixed(2), scenario: s.label });
      await page.evaluate(() => { const d = document.createElement("div"); d.id = "__gl_sync";
        d.style.cssText = "position:fixed;left:0;top:0;width:14px;height:14px;background:#ff00ff;z-index:2147483647;pointer-events:none";
        document.documentElement.appendChild(d); setTimeout(() => d.remove(), 150); }).catch(() => {});
      await page.waitForTimeout(60);
    };
    await s.paintAct(page, mark);
    await page.waitForTimeout(s.watchMs);
  }
  const video = page.video();
  const closeAt = (Date.now() - t0) / 1000;
  await context.close();
  const file = path.join(vdir, `${cell.slug}_paint.webm`);
  if (video) { await video.saveAs(file).catch(() => {}); try { const raw = await video.path(); if (raw !== file) fs.unlinkSync(raw); } catch {} }
  fs.writeFileSync(path.join(vdir, "timeline.json"), JSON.stringify({ closeAt, scenarios: timeline }, null, 1));
  return file;
}

/** Cut frames from the paint-flashing video around the top findings (green = repainted area). */
async function paintEvidence(helper, videoFile, timelineFile, findings, results, dir, cellViewport) {
  const tl = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
  const timeline = tl.scenarios;
  const data = fs.readFileSync(videoFile).toString("base64");
  const page = await helper.context().newPage();
  await page.setContent(`<video id=v muted src="data:video/webm;base64,${data}"></video>`);
  const duration = await page.evaluate(() => new Promise((r) => { const v = document.getElementById("v"); const done = () => r(v.duration); if (v.readyState >= 2) done(); else v.onloadeddata = done; }));
  // the video ends when the page closes, so align wall-clock marks to the video from the end
  const offset = Number.isFinite(duration) ? duration - tl.closeAt : 0;
  const vpW = (VIEWPORTS[cellViewport] || VIEWPORTS.desktop).viewport.width;
  const vScale = (await page.evaluate(() => document.getElementById("v").videoWidth)) / vpW;
  const findSync = (from, to) => page.evaluate(async ({ from, to }) => {
    const v = document.getElementById("v"); const c = document.createElement("canvas"); c.width = 4; c.height = 4; const x = c.getContext("2d");
    for (let t = Math.max(0, from); t <= Math.min(to, v.duration); t += 0.04) {
      v.currentTime = t; await new Promise((r) => (v.onseeked = r));
      x.drawImage(v, 2, 2, 8, 8, 0, 0, 4, 4); const p = x.getImageData(1, 1, 1, 1).data;
      if (p[0] > 200 && p[1] < 80 && p[2] > 200) return t;
    }
    return null;
  }, { from, to });
  // how much of `rect` (css px) is covered by the green paint-flash overlay at each moment in [from, to]
  const scanGreen = (from, to, rect, vpW) => page.evaluate(async ({ from, to, rect, vpW }) => {
    const v = document.getElementById("v"); const k = v.videoWidth / vpW;
    const r = rect ? { x: rect.x * k, y: rect.y * k, w: Math.max(4, rect.w * k), h: Math.max(4, rect.h * k) } : { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
    const c = document.createElement("canvas"); c.width = 48; c.height = 48; const x = c.getContext("2d"); const out = [];
    for (let t = Math.max(0, from); t <= Math.min(to, v.duration - 0.02); t += 0.04) {
      v.currentTime = t; await new Promise((res) => (v.onseeked = res));
      x.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, 48, 48); const d = x.getImageData(0, 0, 48, 48).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 28 && d[i + 1] - d[i + 2] > 22) n++;
      out.push({ t: +t.toFixed(2), g: n / 2304 });
    }
    return out;
  }, { from, to, rect, vpW });
  const grab = (t) => page.evaluate(async (t) => {
    const v = document.getElementById("v"); v.currentTime = Math.max(0, Math.min(t, v.duration - 0.05));
    await new Promise((r) => (v.onseeked = r));
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0); return c.toDataURL("image/png").split(",")[1];
  }, t);
  for (const f of findings.filter((x) => x.level !== "low").slice(0, 6)) {
    const scen = timeline.find((s) => f.scenarios.includes(s.scenario)); if (!scen) continue;
    const r1 = results.find((r) => r.label === scen.scenario && r.rep === 1);
    const g = r1?.glitches.find((x) => x.type === f.type && (!f.component || x.name === f.component || x.components?.some((c) => c.name === f.component)));
    const guess = scen.at + offset;
    const sync = (await findSync(guess - 2, guess + 2)) ?? guess;
    const series = await scanGreen(sync, sync + 3, f.region, vpW);
    const firstG = series.find((x) => x.g > 0.08);
    let times;
    if (firstG) {
      const peak = series.filter((x) => x.t <= firstG.t + 1).reduce((a, b) => (b.g > a.g ? b : a), firstG);
      times = [firstG.t - 0.12, firstG.t, peak.t, peak.t + 0.2, Math.min(sync + 2.9, peak.t + 1.2)];
      f.repaintedPct = Math.round(peak.g * 100);
    } else times = [sync + 0.2, sync + 0.5, sync + 0.8, sync + 1.2, sync + 2];
    const panels = [];
    for (const tt of times) panels.push({ data: await grab(tt), label: `${f.id} · +${Math.round((tt - sync) * 1000)}ms`,
      boxes: f.region ? [{ x: f.region.x * vScale, y: f.region.y * vScale, w: f.region.w * vScale, h: f.region.h * vScale }] : [] });
    f.paintImage = path.join("paint", `${f.id}_paint.png`);
    await composite(helper, panels, path.join(dir, f.paintImage), { thumbW: 280, perRow: 5 });
  }
  await page.close();
}

// ---------------- main ----------------
const browser = await launchBrowser(chromium, args);
const helperCtx = await browser.newContext();
const helper = await helperCtx.newPage();
const index = [];
try {
for (const cell of cells) {
  const dir = ensureDir(path.join(OUT, cell.slug));
  const context = await newContext(browser, cell, args);
  await login(context, cell);
  await context.addInitScript(REACT_SENSOR);
  await context.addInitScript(DOM_OBSERVER);
  const unsafe = [...DEFAULT_UNSAFE, ...(cell.unsafe || []).map((w) => w.toLowerCase())];
  const results = [], errors = [], paintScenarios = [];
  const start = args.start || cell.start || (cell.screens || ["/"])[0];

  if (mode === "nav") {
    const page = await context.newPage(); attachListeners(page, { console: [], failed: [] });
    await prepPage(context, page, cell);
    await page.goto(cell.base + tpl(start, cell), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    let items;
    const given = args.items ? String(args.items).split(",").map((s) => s.trim()).filter(Boolean) : cell.nav?.items || cfg.nav?.items;
    if (given?.length) items = given.map((x) => (typeof x === "string" ? { text: x } : x));
    else items = (await page.evaluate(discoverNav, unsafe)).slice(0, MAX_ITEMS);
    if (items.length < 2) { errors.push(`found only ${items.length} navigation link(s); pass --items "A,B,C" or set nav.items in the config`); }
    const pairs = [];
    if ((args.mode || "ring") === "full") { for (const a of items) for (const b of items) if (a !== b) pairs.push([a, b]); }
    else for (let i = 0; i < items.length; i++) pairs.push([items[i], items[(i + 1) % items.length]]);
    const chosen = pairs.slice(0, MAX_T);
    console.log(`[${cell.id}] nav items: ${items.map((i) => i.text || i.path).join(" · ")} → ${chosen.length} transitions × ${REPEAT} runs, CPU ${CPU}×`);
    for (let rep = 1; rep <= REPEAT; rep++) {
      for (const [a, b] of chosen) {
        const label = `nav ${a.text || a.path} → ${b.text || b.path}`;
        if (a.path ? here(page) !== a.path : true) { await clickItem(page, a, cell).catch(() => {}); await page.waitForTimeout(1500); }
        const r = await runScenario({ page, cell, dir, helper, rep, label, kind: "nav", watchMs: AFTER_MS,
          name: slugify(`nav_${a.text || a.path}_to_${b.text || b.path}`), act: () => clickItem(page, b, cell) });
        if (r.error) errors.push(`${label}: ${r.error}`);
        results.push(r);
        console.log(`[${cell.id}] r${rep} ${label}: ${r.glitches.length} signal(s)${r.react.available ? "" : " (no React)"}`);
        if (rep === 1) paintScenarios.push({ label, watchMs: AFTER_MS, paintAct: async (p, mark) => {
          if (p.url() === "about:blank") { await p.goto(cell.base + tpl(start, cell)); await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}); await p.waitForTimeout(1500); }
          if (a.path ? here(p) !== a.path : true) { await clickItem(p, a, cell); await p.waitForTimeout(1500); }
          await mark(); await clickItem(p, b, cell); } });
      }
    }
    await page.close();
  } else if (mode === "loads" || mode === "idle") {
    const screens = args.url ? [cell.start] : cell.screens || ["/"];
    for (let rep = 1; rep <= REPEAT; rep++) for (const screen of screens) {
      const page = await context.newPage(); attachListeners(page, { console: [], failed: [] });
      await prepPage(context, page, cell);
      const url = cell.base + tpl(screen, cell);
      let r;
      if (mode === "loads") {
        r = await runScenario({ page, cell, dir, helper, rep, label: `load ${screen}`, kind: "load", watchMs: WATCH_MS,
          name: slugify(`load_${screen}`), act: () => page.goto(url, { waitUntil: "commit", timeout: 60000 }) });
      } else {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        r = await runScenario({ page, cell, dir, helper, rep, label: `idle ${screen}`, kind: "idle", watchMs: IDLE_MS,
          name: slugify(`idle_${screen}`), act: async () => {} });
      }
      if (r.error) errors.push(`${r.label}: ${r.error}`);
      results.push(r);
      console.log(`[${cell.id}] r${rep} ${r.label}: ${r.glitches.length} signal(s)`);
      if (rep === 1) paintScenarios.push({ label: r.label, watchMs: mode === "loads" ? WATCH_MS : IDLE_MS, paintAct: async (p, mark) => { if (mode === "idle") { await p.goto(url); await p.waitForTimeout(2000); await mark(); } else { if (p.url() === "about:blank") await p.goto("data:text/html,<body></body>"); await mark(); await p.goto(url); } } });
      await page.close();
    }
  } else if (mode === "journey") {
    const jid = args.journey; const j = cfg.journeys?.[jid];
    if (!j) { console.error(`Unknown journey "${jid}". Available: ${Object.keys(cfg.journeys || {}).join(", ")}`); process.exit(1); }
    const replySel = j.steps.filter((st) => st.measureResponse?.selector).map((st) => st.measureResponse.selector);
    const jCell = { ...cell, mask: [...cell.mask, ...replySel] };
    for (let rep = 1; rep <= REPEAT; rep++) {
      const page = await context.newPage(); attachListeners(page, { console: [], failed: [] });
      await prepPage(context, page, cell);
      for (let i = 0; i < j.steps.length; i++) {
        const s = j.steps[i];
        const kind = Object.keys(s).find((k) => !["shot", "timeout", "note", "optional"].includes(k));
        if (!["goto", "click", "fill", "press"].includes(kind)) continue;
        let tr = null;
        const act = async () => {
          if (kind === "goto") return page.goto(cell.base + tpl(s.goto, cell), { waitUntil: "commit", timeout: 60000 });
          if (kind === "press") { requireInteraction(args, true); return page.keyboard.press(s.press); }
          const loc = locatorFor(page, kind === "click" ? s.click : s.fill, cell);
          const bb = await loc.boundingBox({ timeout: s.timeout || 15000 }).catch(() => null);
          if (bb) tr = { x: bb.x - 40, y: bb.y - 40, w: bb.width + 80, h: bb.height + 80 };
          if (kind === "click") await checkTarget(loc, cell, args);
          else requireInteraction(args, true);
          return kind === "click" ? loc.click({ timeout: s.timeout || 15000 }) : loc.fill(tpl(s.fill.value, cell), { timeout: s.timeout || 15000 });
        };
        const what = typeof s[kind] === "string" ? s[kind] : s[kind]?.name || s[kind]?.label || s[kind]?.placeholder || "";
        const r = await runScenario({ page, cell: jCell, dir, helper, rep, label: `${jid} #${i} ${kind} ${what}`.trim(), kind: kind === "goto" ? "load" : "interaction",
          watchMs: kind === "goto" ? WATCH_MS : AFTER_MS, name: slugify(`${jid}_${String(i).padStart(2, "0")}_${kind}_${what}`), act, targetRectFn: () => tr });
        results.push(r);
        console.log(`[${cell.id}] r${rep} ${r.label}: ${r.error ? "ERROR " + r.error + " · " : ""}${r.glitches.length} signal(s)`);
        if (r.error) { errors.push(`${r.label}: ${r.error}`); if (!s.optional) break; }
      }
      await page.close();
    }
  } else {
    console.error(`Unknown mode "${mode}". Use nav | loads | idle | journey.`); process.exit(1);
  }

  let paintFile = null;
  if (args.paint && paintScenarios.length) { paintFile = await paintPass(browser, cell, paintScenarios, dir, await context.storageState()).catch((e) => (errors.push("paint: " + e.message), null)); }
  if (!results.length) errors.push("No scenarios executed");
  if (context._uxBlocked.length) errors.push(`${context._uxBlocked.length} requests blocked by safety policy; coverage is incomplete`);
  const findings = aggregate(results);
  if (paintFile && fs.existsSync(paintFile)) await paintEvidence(helper, paintFile, path.join(dir, "paint", "timeline.json"), findings, results, dir, cell.viewport).catch((e) => errors.push("paint frames: " + e.message));
  const renderTotals = {};
  for (const r of results) for (const [n, c] of Object.entries(r.renders || {})) renderTotals[n] = (renderTotals[n] || 0) + c;
  const meta = { mode, scenarios: new Set(results.map((r) => r.label)).size, react: results.some((r) => r.react.available),
    commits: results.reduce((a, r) => a + (r.react.commits || 0), 0), errors, dir,
    renders: Object.entries(renderTotals).filter(([n]) => !FRAMEWORK.has(n)).sort((a, b) => b[1] - a[1]), paint: paintFile };
  fs.writeFileSync(path.join(dir, "findings.json"), JSON.stringify({ cell: cell.id, mode, repeat: REPEAT, cpu: CPU, viewport: cell.viewport, meta, findings }, null, 2));
  const md = summaryMd(cell, findings, meta);
  fs.writeFileSync(path.join(dir, "summary.md"), md);
  index.push({ cell: cell.id, dir, ok: !errors.length, findings: findings.length, high: findings.filter((f) => f.level === "high").length });
  console.log("\n" + md + "\n");
  await context.close();
}
fs.writeFileSync(path.join(ensureDir(OUT), "index.json"), JSON.stringify(index, null, 2));
} finally { await browser.close(); }
if (!index.length || index.some((r) => !r.ok)) process.exitCode = 1;
