// Bounded exploration of rendered UI states. Never invents business acceptance criteria.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bounded, checkTarget, requireInteraction } from "./lib.mjs";

export async function inventory(page, classify, touch, maxScrolls = 12) {
  const found = new Map();
  const add = async () => {
    const res = await page.evaluate(classify, { touch });
    for (const item of res.results) found.set(item.key, item);
    return res;
  };
  let res = await add();
  // Scroll the document and bounded nested scroll containers; virtualized controls may appear lazily.
  const scroll = await page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll("body *")].filter((e) => e && e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 40 &&
      (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)));
    return els.slice(0, 8).map((e, i) => { e.setAttribute("data-ux-scroll", String(i)); return { i, top: e.scrollTop }; });
  });
  let steps = 0, truncated = false;
  for (const container of scroll) {
    const loc = page.locator(`[data-ux-scroll="${container.i}"]`);
    await loc.evaluate((e) => { e.scrollTop = 0; });
    while (true) {
      if (steps++ >= maxScrolls) { truncated = true; break; }
      await page.waitForTimeout(60);
      res = await add();
      const more = await loc.evaluate((e) => { const before = e.scrollTop; e.scrollTop += Math.max(40, e.clientHeight * 0.8); return e.scrollTop > before; });
      if (!more) break;
    }
    await loc.evaluate((e, top) => { e.scrollTop = top; }, container.top);
    if (truncated) break;
  }
  await add();
  return { ...res, results: [...found.values()], scrollTruncated: truncated,
    limitations: "Rendered light DOM only; closed shadow roots, iframe contents and unvisited virtualized states are not covered." };
}

const stateKey = (url, items) => createHash("sha256").update(JSON.stringify([url, items.map((i) => [i.key, i.disabled, i.expanded, i.selected, i.checked])])).digest("hex");
async function snapshot(page) {
  return page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 40000),
    controls: [...document.querySelectorAll("input,select,textarea,[aria-expanded],[aria-selected],[aria-checked],details")].map((e) =>
      [e.tagName, e.id, e.type === "password" ? "<redacted>" : e.value, e.checked, e.open, e.getAttribute("aria-expanded"), e.getAttribute("aria-selected"), e.getAttribute("aria-checked")]),
    invalid: [...document.querySelectorAll(":invalid")].map((e) => e.validationMessage) }));
}
function sameControl(current, target) { return current.key === target.key; }
async function locate(page, classify, touch, target) {
  const current = await page.evaluate(classify, { touch });
  const match = current.results.find((i) => sameControl(i, target));
  if (!match) throw new Error("Control is absent or changed since discovery");
  return page.locator(match.selector);
}

export async function explore(page, url, initial, cell, args, classify, dir, prefix) {
  requireInteraction(args);
  const maxActions = bounded(args["max-actions"] ?? args["max-clicks"], 40, 200);
  const maxStates = bounded(args["max-states"], 12, 50), maxPages = bounded(args["max-pages"], 5, 25);
  const maxDepth = bounded(args["max-depth"], 4, 8), seconds = bounded(args.seconds, 120, 600);
  const observeMs = bounded(args["observe-ms"], 1000, 5000);
  const touch = !!cell.touch, start = Date.now(), deadline = start + seconds * 1000;
  const states = [], actions = [], replays = [], visited = new Set(), pages = new Set([url]);
  const context = page.context();
  context._uxPageBudget = { urls: pages, limit: maxPages, hit: false };
  const guardHistory = () => page.evaluate(({ limit, urls }) => {
    const installed = !!window.__uxNavBudget;
    window.__uxNavBudget = { limit, urls, hit: false };
    if (installed) return;
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function (data, unused, target) {
        const next = new URL(target ?? location.href, location.href).href, budget = window.__uxNavBudget;
        if (!budget.urls.includes(next) && budget.urls.length >= budget.limit) { budget.hit = true; throw new Error("Exploration page limit reached"); }
        if (!budget.urls.includes(next)) budget.urls.push(next);
        window.__uxHistoryVisit(next).catch(() => {});
        return original.call(this, data, unused, target);
      };
    }
  }, { limit: maxPages, urls: [...pages] });
  let actualClicks = 0;
  const beforeClick = () => {
    if (actualClicks >= maxActions || Date.now() >= deadline) { limited = true; throw new Error("Action/time limit reached"); }
    actualClicks++;
  };
  const queue = [{ sequence: [], items: initial.results, url }];
  let limited = initial.scrollTruncated;
  while (queue.length && states.length < maxStates && actualClicks < maxActions && Date.now() < deadline) {
    const state = queue.shift(), key = stateKey(state.url, state.items);
    if (visited.has(key)) continue;
    visited.add(key); pages.add(state.url);
    const id = states.length;
    states.push({ id, url: state.url, depth: state.sequence.length, controls: state.items.length });
    for (const target of state.items) {
      const rec = { state: id, control: target.key, text: target.text || target.name, selector: target.selector, result: "skipped", attempted: false };
      if (["fake", "fake-icon"].includes(target.cat)) rec.reason = "Non-semantic candidate; human review required";
      else if (target.field) rec.reason = "Input needs explicit journey values";
      else if (target.disabled) rec.reason = "Disabled control";
      else if (state.sequence.length >= maxDepth) rec.reason = "Depth limit";
      else if (actualClicks >= maxActions || Date.now() >= deadline) { rec.reason = "Action/time limit"; limited = true; }
      else {
        try {
          // Recreate the starting state for each independent probe; never chain unrelated clicks.
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
          await guardHistory();
          for (const prior of state.sequence) {
            const loc = await locate(page, classify, touch, prior);
            await checkTarget(loc, cell, args, true);
            beforeClick();
            const replay = { control: prior.key, state: id, ok: false }; replays.push(replay);
            await loc.click({ timeout: 2000 }); replay.ok = true;
            await page.waitForTimeout(100);
          }
          const loc = await locate(page, classify, touch, target);
          try { await checkTarget(loc, cell, args, true); } catch (e) { rec.reason = e.message; actions.push(rec); continue; }
          await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
          await loc.click({ trial: true, timeout: 1500 });
          const baseline = await snapshot(page);
          await page.waitForTimeout(150);
          const before = await snapshot(page), blocked = page.context()._uxBlocked.length;
          const noisy = JSON.stringify(baseline) !== JSON.stringify(before);
          const events = [], errors = [];
          const dialog = async (d) => { events.push(`dialog:${d.type()}`); await d.dismiss(); };
          const download = async (d) => { events.push("download"); await d.cancel(); };
          const popup = async (p) => { events.push("popup"); await p.close(); };
          const error = (e) => errors.push(e.message);
          const consoleError = (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); };
          page.on("dialog", dialog); page.on("download", download); page.on("popup", popup); page.on("pageerror", error); page.on("console", consoleError);
          rec.before = `${prefix}_action_${actions.length}_before.png`;
          await page.screenshot({ path: path.join(dir, rec.before), mask: cell.mask.map((s) => page.locator(s)) });
          const t0 = Date.now();
          try {
            beforeClick(); rec.attempted = true;
            await loc.click({ timeout: 2000 });
            let after = before;
            while (Date.now() - t0 < observeMs && Date.now() < deadline) {
              after = await snapshot(page);
              if (rec.latencyMs === undefined && (JSON.stringify(after) !== JSON.stringify(before) || events.length)) rec.latencyMs = Date.now() - t0;
              await page.waitForTimeout(100);
            }
            rec.events = events;
            rec.errors = errors;
            const historyLimit = await page.evaluate(() => window.__uxNavBudget?.hit || false);
            limited ||= historyLimit || context._uxPageBudget.hit;
            if (historyLimit) rec.reason = "Page limit reached";
            rec.result = historyLimit || page.context()._uxBlocked.length > blocked ? "blocked" : errors.length ? "error" : rec.latencyMs !== undefined ? noisy && after.url === before.url && !events.length ? "inconclusive" : "responded" : "no-observable-response";
            if (rec.result === "inconclusive") rec.reason = "Page was changing before the click; response cannot be attributed reliably";
            rec.after = `${prefix}_action_${actions.length}_after.png`;
            await page.screenshot({ path: path.join(dir, rec.after), mask: cell.mask.map((s) => page.locator(s)) });
            const next = await inventory(page, classify, touch);
            limited ||= next.scrollTruncated;
            if (rec.result === "responded" && !visited.has(stateKey(page.url(), next.results))) {
              if (pages.has(page.url()) || pages.size < maxPages) {
                pages.add(page.url()); queue.push({ sequence: [...state.sequence, target], items: next.results, url: page.url() });
              } else limited = true;
            }
          } finally {
            page.off("dialog", dialog); page.off("download", download); page.off("popup", popup); page.off("pageerror", error); page.off("console", consoleError);
          }
        } catch (e) { rec.result = rec.attempted ? "error" : "blocked"; rec.reason = e.message.split("\n")[0]; }
      }
      actions.push(rec);
    }
  }
  limited ||= queue.length > 0 || context._uxPageBudget.hit;
  delete context._uxPageBudget;
  const counts = actions.reduce((a, r) => ({ ...a, [r.result]: (a[r.result] || 0) + 1 }), {});
  const result = { states, actions, replays, actualClicks, maxActions, counts, discovered: actions.length, exercised: actions.filter((a) => a.attempted).length,
    limited, pendingStates: queue.length, elapsedMs: Date.now() - start,
    limitations: "Responded means an observable effect, NOT correct business behavior. No-response is not proof of a dead control. Clipboard and hover-only interactions need explicit journeys. Reload/replay does not roll back server data." };
  fs.writeFileSync(path.join(dir, `${prefix}_coverage.json`), JSON.stringify(result, null, 2));
  return result;
}
