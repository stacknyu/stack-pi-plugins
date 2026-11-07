#!/usr/bin/env node
/**
 * affordance_scan.mjs — find visual affordance problems on rendered screens.
 *
 *   node affordance_scan.mjs --config .ux/matrix.json --cell teen-applicant@brightpath --out .ux/runs/2026-09-23
 *   node affordance_scan.mjs --url http://localhost:3000/chat --viewport mobile --out .ux/runs/adhoc
 *   options: --all (every cell) --probe-clicks --max-clicks 20 --auth-dir .ux/auth
 *
 * Categories (box colors in *_annotated.png):
 *   control  (green)  real control that also looks like one
 *   fake     (red)    looks clickable, but nothing happens (not a control)
 *   hidden   (orange) is clickable, but looks like plain text/decoration
 *   unlabeled(purple) icon-only control, no visible text or accessible name
 *   small    (yellow) touch target below 24px (44px recommended on touch devices)
 * These are CANDIDATES. Review the screenshots and judge as the persona.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, loadPlaywright, launchBrowser, loadConfig, resolveCells, newContext, login, throttle,
         attachListeners, slugify, ensureDir, tpl, VIEWPORTS, freshOutput, requireInteraction } from "./lib.mjs";
import { inventory, explore } from "./interactions.mjs";

const args = parseArgs();
const OUT = args.out || ".ux/runs/adhoc";
if (args["probe-clicks"]) requireInteraction(args);
freshOutput(OUT);
const { chromium } = await loadPlaywright();

let cells;
if (args.url) {
  const u = new URL(args.url);
  cells = [{ id: "adhoc", slug: "adhoc", base: u.origin, screens: [u.pathname + u.search], viewport: args.viewport || "desktop",
             network: args.network || "fast", unsafe: [], persona: {}, partner: {}, mask: [] }];
} else {
  const cfg = loadConfig(args.config);
  cells = resolveCells(cfg, args.cell, args.all);
}

// ---------- in-page classifier ----------
function classify(opts) {
  const { touch } = opts;
  const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "checkbox", "switch", "option", "radio", "combobox", "treeitem", "slider"]);
  const vis = (el, cs) => {
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05;
  };
  const isSemantic = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === "a" && el.hasAttribute("href")) return true;
    if (["button", "select", "textarea", "summary"].includes(t)) return true;
    if (t === "input" && el.type !== "hidden") return true;
    if (t === "label" && el.htmlFor) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick") || el.isContentEditable) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && +ti >= 0;
  };
  const isPointerRoot = (el, cs) => cs.cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer");
  const parseRGB = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
  const alpha = (c) => { const v = parseRGB(c); return v.length > 3 ? v[3] : 1; };
  const effBg = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (alpha(b) > 0.1) return b; } return "rgb(255,255,255)"; };
  const dist = (a, b) => { const x = parseRGB(a), y = parseRGB(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const hueSat = (c) => {
    let [r, g, b] = parseRGB(c).map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
  };
  const text = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const accName = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") ||
    (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText) ||
    el.labels?.[0]?.innerText || el.getAttribute("placeholder") || el.querySelector("img[alt]")?.alt || el.querySelector("svg title")?.textContent || "").trim();
  const selectorFor = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
    }
    return parts.join(" > ") || "body";
  };
  const bodyColor = getComputedStyle(document.body).color;

  const looksLikeButton = (el, cs, r, t) => {
    const words = t ? t.split(" ").length : 0;
    const bgDiff = alpha(cs.backgroundColor) > 0.1 && dist(cs.backgroundColor, effBg(el.parentElement || el)) > 40;
    const bordered = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== "none" && parseFloat(cs.borderRadius) >= 3;
    const rounded = parseFloat(cs.borderRadius) >= 3;
    const padded = parseFloat(cs.paddingLeft) >= 6 && parseFloat(cs.paddingTop) >= 3;
    return words >= 1 && words <= 5 && r.width < 360 && r.height >= 18 && r.height <= 72 && padded && ((bgDiff && rounded) || bordered);
  };
  const looksLikeLink = (el, cs, t) => {
    if (!t || t.split(" ").length > 8 || el.children.length > 1) return false;
    if (cs.textDecorationLine.includes("underline")) return true;
    const hs = hueSat(cs.color);
    return hs.h > 190 && hs.h < 250 && hs.s > 0.45 && hs.v > 0.35 && dist(cs.color, bodyColor) > 80;
  };
  const looksLikeIconControl = (el, r, t) => !t && r.width >= 14 && r.width <= 56 && r.height >= 14 && r.height <= 56 &&
    el.querySelector("svg,img") && el.children.length <= 2;
  const looksPlain = (el, cs, t) => {
    const bgDiff = alpha(cs.backgroundColor) > 0.1 && dist(cs.backgroundColor, effBg(el.parentElement || el)) > 25;
    const border = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== "none";
    const shadow = cs.boxShadow && cs.boxShadow !== "none";
    return t && !bgDiff && !border && !shadow && !cs.textDecorationLine.includes("underline") && dist(cs.color, bodyColor) < 40;
  };

  const all = [...document.querySelectorAll("body *")];
  const results = [];
  const interactiveSet = new Set();
  for (const el of all) {
    if (el.closest("[data-ux-overlay]")) continue;
    const cs = getComputedStyle(el);
    if (!vis(el, cs)) continue;
    if (isSemantic(el) || isPointerRoot(el, cs)) interactiveSet.add(el);
  }
  const hasInteractiveAncestor = (el) => { for (let e = el.parentElement; e; e = e.parentElement) if (interactiveSet.has(e)) return true; return false; };
  const labels = {};
  let idx = 0;
  for (const el of all) {
    if (el.closest("[data-ux-overlay]") || ["svg", "path", "g", "script", "style"].includes(el.tagName.toLowerCase())) continue;
    const cs = getComputedStyle(el);
    if (!vis(el, cs)) continue;
    const r = el.getBoundingClientRect();
    const t = text(el).slice(0, 80);
    const interactive = interactiveSet.has(el);
    const nested = hasInteractiveAncestor(el);
    const isField = ["input", "select", "textarea"].includes(el.tagName.toLowerCase()) || el.isContentEditable;
    const reasons = [];
    let cat = null;
    if (interactive && !nested) {
      const name = t || accName(el);
      if (!t && !isField && !accName(el)) { cat = "unlabeled"; reasons.push("icon-only control with no text or accessible name"); }
      else if (!isField && looksPlain(el, cs, t) && !(cs.cursor === "pointer" && el.closest("nav,header,[role=navigation],[role=menu],[role=tablist]"))) {
        cat = "hidden"; reasons.push("clickable but styled like body text (no color, underline, border or background)");
      } else cat = "control";
      const min = touch ? 44 : 24;
      if (!isField && (r.width < min || r.height < min)) { reasons.push(`target ${Math.round(r.width)}×${Math.round(r.height)}px < ${min}px`); if (cat === "control") cat = "small"; }
      if (!isField && name) (labels[name.toLowerCase()] ||= []).push(el.tagName.toLowerCase() === "a" ? el.getAttribute("href") : "(action)");
      if (/^(click here|here|submit|ok|go|more|details|continue|next|button)$/i.test(name)) reasons.push(`vague label "${name}"`);
    } else if (!interactive && !nested) {
      // leaf-ish, non-interactive element that looks interactive
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || !el.children.length || el.querySelector(":scope > svg, :scope > img");
      if (direct) {
        if (looksLikeButton(el, cs, r, t)) { cat = "fake"; reasons.push("styled like a button (filled/bordered, padded, short label) but not clickable"); }
        else if (looksLikeLink(el, cs, t)) { cat = "fake"; reasons.push("styled like a link (blue or underlined) but not clickable"); }
        else if (looksLikeIconControl(el, r, t) && !el.closest("p,li,td,h1,h2,h3,h4")) { cat = "fake-icon"; reasons.push("standalone icon sized like a control but not clickable (verify: may be decorative)"); }
      }
    }
    if (!cat) continue;
    el.setAttribute("data-ux-id", String(idx));
    const selector = selectorFor(el), name = accName(el);
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    const hit = inView ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    results.push({ id: idx++, key: JSON.stringify([selector, el.tagName, el.getAttribute("href"), t, name]), selector,
      disabled: el.matches(":disabled,[aria-disabled=true]"), focusable: el.tabIndex >= 0,
      covered: inView && !!hit && !el.contains(hit), offscreen: !inView,
      expanded: el.getAttribute("aria-expanded"), selected: el.getAttribute("aria-selected"), checked: el.checked ?? el.getAttribute("aria-checked"),
      cat, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), text: t, name,
      href: el.getAttribute("href"), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height),
      reasons, field: isField });
  }
  const dupes = Object.entries(labels).filter(([, v]) => new Set(v).size > 1 && v.length > 1).map(([k, v]) => ({ label: k, count: v.length, targets: [...new Set(v)].slice(0, 5) }));
  return { results, dupes, page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, title: document.title } };
}

function drawOverlay(items) {
  const COLORS = { control: "#16a34a", fake: "#dc2626", "fake-icon": "#dc2626", hidden: "#ea580c", unlabeled: "#9333ea", small: "#ca8a04" };
  const layer = document.createElement("div");
  layer.setAttribute("data-ux-overlay", "1");
  Object.assign(layer.style, { position: "absolute", left: 0, top: 0, width: "100%", height: document.documentElement.scrollHeight + "px", pointerEvents: "none", zIndex: 2147483647 });
  for (const it of items) {
    const c = COLORS[it.cat] || "#000";
    const b = document.createElement("div");
    Object.assign(b.style, { position: "absolute", left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px",
      outline: `${it.cat === "control" ? 1 : 3}px solid ${c}`, background: it.cat === "control" ? "transparent" : c + "22" });
    if (it.cat !== "control") {
      const tag = document.createElement("div");
      tag.textContent = it.id;
      Object.assign(tag.style, { position: "absolute", left: "-2px", top: "-16px", font: "bold 11px/14px sans-serif", color: "#fff", background: c, padding: "0 4px", borderRadius: "3px" });
      b.appendChild(tag);
    }
    layer.appendChild(b);
  }
  document.body.appendChild(layer);
}

// ---------- main ----------
const browser = await launchBrowser(chromium, args);

try {
for (const cell of cells) {
  const context = await newContext(browser, cell, args);
  await login(context, cell);
  const dir = ensureDir(path.join(OUT, cell.slug, "affordance"));
  const screens = cell.screens || ["/"];
  const touch = !!(VIEWPORTS[cell.viewport] || {}).hasTouch;
  const summary = [];
  for (const screen of screens) {
    const page = await context.newPage();
    const sink = { console: [], failed: [] };
    attachListeners(page, sink);
    await throttle(context, page, cell);
    const url = cell.base + tpl(screen, cell);
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (cell.login?.authenticated) await page.locator(cell.login.authenticated).waitFor();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(500);
    const name = slugify(screen);
    await page.screenshot({ path: path.join(dir, `${name}_clean.png`), fullPage: true, mask: cell.mask.map((s) => page.locator(s)) });
    const res = await inventory(page, classify, touch);
    res.page.horizontalOverflow = res.page.w > page.viewportSize().width + 1;
    await page.evaluate(drawOverlay, res.results);
    await page.screenshot({ path: path.join(dir, `${name}_annotated.png`), fullPage: true, mask: cell.mask.map((s) => page.locator(s)) });
    await page.evaluate(() => document.querySelector('[data-ux-overlay]')?.remove());
    const coverage = args["probe-clicks"] ? await explore(page, url, res, { ...cell, touch }, args, classify, dir, name) : null;
    const clicks = coverage?.actions || [];
    const counts = res.results.reduce((a, r) => ((a[r.cat] = (a[r.cat] || 0) + 1), a), {});
    const data = { cell: cell.id, screen, url, viewport: cell.viewport, network: cell.network, loadMs, title: res.page.title,
      counts, duplicateLabels: res.dupes, items: res.results, clicks, coverage,
      scrollTruncated: res.scrollTruncated, limitations: res.limitations, horizontalOverflow: res.page.horizontalOverflow,
      blockedRequests: context._uxBlocked,
      consoleErrors: sink.console.slice(0, 20), failedRequests: sink.failed.slice(0, 20) };
    fs.writeFileSync(path.join(dir, `${name}_affordance.json`), JSON.stringify(data, null, 2));
    summary.push({ screen, loadMs, ...counts, coverage: coverage && { ...coverage.counts, states: coverage.states.length, limited: coverage.limited }, errors: sink.console.length });
    console.log(`[${cell.id}] ${screen}: load ${loadMs}ms · fake ${(counts.fake || 0) + (counts["fake-icon"] || 0)} · hidden ${counts.hidden || 0} · unlabeled ${counts.unlabeled || 0} · small ${counts.small || 0}` +
      (coverage ? ` · ${coverage.exercised}/${coverage.discovered} control-state pairs exercised, ${coverage.states.length} states · ${JSON.stringify(coverage.counts)}${coverage.limited ? " · LIMITED" : ""}` : " · observation only"));
    await page.close();
  }
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ cell: cell.id, viewport: cell.viewport, network: cell.network, screens: summary }, null, 2));
  await context.close();
}
} finally { await browser.close(); }
