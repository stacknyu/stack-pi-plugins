#!/usr/bin/env node
/**
 * journey_runner.mjs — run persona journeys in a real browser, screenshot every step,
 * time what the user waits for, check what must / must not be on screen,
 * and optionally save a baseline or compare against one (visual regression).
 *
 *   node journey_runner.mjs --config .ux/matrix.json --cell teen-applicant@brightpath --out .ux/runs/2026-09-23
 *   node journey_runner.mjs --config .ux/matrix.json --all --baseline .ux/baseline
 *   node journey_runner.mjs --config .ux/matrix.json --all --compare .ux/baseline --out .ux/runs/2026-09-30
 *   options: --journey <id>  --diff-threshold 0.001 (fraction of pixels; mask dynamic areas like AI replies and timestamps via "mask")  --slow-factor 2  --auth-dir .ux/auth
 *
 * Step types (see assets/matrix.example.json):
 *   {"goto": "/chat"}
 *   {"click": "New chat"}                  visible text; or {"click": {"role":"button","name":"Send"}} / {"click": {"selector": "..."}}
 *   {"fill": {"label": "Message", "value": "..."}}   or {"placeholder": ...} / {"selector": ...}
 *   {"press": "Enter"}
 *   {"waitForText": "Scholarship", "timeout": 30000}
 *   {"measureResponse": {"selector": "[data-role=assistant]:last-of-type", "timeout": 60000}}
 *        records time to first visible output and time until output stops changing (AI streaming)
 *   {"expectText": "{{partner.name}}"}     {"expectNoText": ["Tax agent", "OtherPartner"]}
 *   {"screenshot": "after-send"}           {"wait": 1000}
 * Every step gets a screenshot automatically; set "shot": false to skip.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, loadPlaywright, launchBrowser, loadConfig, resolveCells, newContext, login, throttle,
         attachListeners, slugify, ensureDir, tpl, locatorFor, freshOutput, requireInteraction, checkTarget, bounded } from "./lib.mjs";

const args = parseArgs();
const cfg = loadConfig(args.config);
const cells = resolveCells(cfg, args.cell, args.all);
const baselineMode = !!args.baseline;
const OUT = baselineMode ? args.baseline : args.out || ".ux/runs/latest";
if (args.baseline && args.compare) throw new Error("Choose baseline or compare, not both");
if (args.compare && path.resolve(args.compare) === path.resolve(OUT)) throw new Error("Comparison output must differ from baseline");
freshOutput(OUT);
for (const cell of cells) {
  const ids = args.journey ? [args.journey] : cell.journeys || [];
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || !cfg.journeys?.[id]?.steps?.length)) throw new Error(`Missing/empty journey for ${cell.id}`);
}
const DIFF_T = Number(args["diff-threshold"] || 0.001);
if (!Number.isFinite(DIFF_T) || DIFF_T < 0 || DIFF_T > 1) throw new Error("Invalid diff threshold");
const SLOW_F = Number(args["slow-factor"] || 2);
const { chromium } = await loadPlaywright();
const browser = await launchBrowser(chromium, args);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


/** Visible text as separate chunks (innerText glues adjacent inline elements together). */
async function visibleText(page) {
  return page.evaluate(() => {
    const out = [document.title];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const t = n.textContent.trim(); if (!t) continue;
      const el = n.parentElement; if (!el) continue;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0 || !r.width || !r.height) continue;
      out.push(t);
    }
    document.querySelectorAll("[aria-label],img[alt],[title]").forEach((e) => {
      const r = e.getBoundingClientRect(); if (!r.width) return;
      out.push(e.getAttribute("aria-label") || e.getAttribute("alt") || e.getAttribute("title"));
    });
    return out.filter(Boolean).join(" \u2502 ");
  });
}

async function measureResponse(page, spec) {
  const sel = spec.selector, timeout = spec.timeout || 60000, stableMs = spec.stableMs || 2000;
  const armed = page._uxResponseStart?.selector === sel ? page._uxResponseStart : null;
  const t0 = armed?.t0 ?? Date.now();
  const initial = armed?.initial ?? await page.locator(sel).last().innerText({ timeout: 200 }).catch(() => "");
  page._uxResponseStart = null;
  let first = null, lastChange = null, last = initial, completed = false;
  while (Date.now() - t0 < timeout) {
    const cur = await page.locator(sel).last().innerText({ timeout: 200 }).catch(() => "");
    if (cur !== last) { if (first === null) first = Date.now() - t0; lastChange = Date.now() - t0; last = cur; }
    if (lastChange !== null && Date.now() - t0 - lastChange > stableMs) { completed = true; break; }
    await page.waitForTimeout(100);
  }
  return { firstOutputMs: first, completeMs: lastChange, timedOut: !completed, chars: last.length };
}

async function visualDiff(page, aPath, bPath, outPath) {
  const a = "data:image/png;base64," + fs.readFileSync(aPath).toString("base64");
  const b = "data:image/png;base64," + fs.readFileSync(bPath).toString("base64");
  const res = await page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((resolve, reject) => { const i = new Image(), timer = setTimeout(() => reject(new Error("Image decoding timed out")), 5000);
      i.onload = () => { clearTimeout(timer); resolve(i); }; i.onerror = () => { clearTimeout(timer); reject(new Error("Invalid comparison image")); }; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h), cd = new OffscreenCanvas(w, h);
    const xa = ca.getContext("2d"), xb = cb.getContext("2d"), xd = cd.getContext("2d");
    xa.drawImage(ia, 0, 0); xb.drawImage(ib, 0, 0);
    const da = xa.getImageData(0, 0, w, h).data, db = xb.getImageData(0, 0, w, h).data;
    xd.globalAlpha = 0.35; xd.drawImage(ib, 0, 0); xd.globalAlpha = 1;
    const out = xd.getImageData(0, 0, w, h); let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 60) { diff++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 80; out.data[i + 3] = 255; }
    }
    xd.putImageData(out, 0, 0);
    const blob = await cd.convertToBlob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { ratio: diff / (w * h), sizeChanged: ia.width !== ib.width || ia.height !== ib.height, png: btoa(s) };
  }, { a, b });
  fs.writeFileSync(outPath, Buffer.from(res.png, "base64"));
  return { ratio: +res.ratio.toFixed(4), sizeChanged: res.sizeChanged };
}

async function assertEventually(check, timeout) {
  const end = Date.now() + timeout;
  while (true) {
    if (await check()) return;
    if (Date.now() >= end) throw new Error("Acceptance assertion did not hold within timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const allResults = [];
try {
const helper = args.compare ? await browser.newPage() : null;
for (const cell of cells) {
  const context = await newContext(browser, cell, args);
  await login(context, cell);
  const jids = args.journey ? [args.journey] : cell.journeys || [];
  for (const jid of jids) {
    const journey = cfg.journeys?.[jid];
    if (!journey) throw new Error(`Unknown journey ${jid}`);
    const dir = ensureDir(path.join(OUT, cell.slug, "journeys", jid));
    const page = await context.newPage();
    const sink = { console: [], failed: [] };
    attachListeners(page, sink);
    await throttle(context, page, cell);
    const steps = [];
    let broken = false;
    const jStart = Date.now();
    for (let i = 0; i < journey.steps.length; i++) {
      const s = journey.steps[i];
      const kind = Object.keys(s).find((k) => !["shot", "timeout", "note", "optional"].includes(k));
      const rec = { i, kind, arg: kind === "fill" ? { ...s.fill, value: "<redacted>" } : s[kind], note: s.note, required: !s.optional, ok: true };
      const t0 = Date.now();
      if (broken) { rec.ok = false; rec.skipped = true; steps.push(rec); continue; }
      try {
        const to = bounded(s.timeout, 10000, 60000);
        const nextResponse = journey.steps[i + 1]?.measureResponse;
        if (nextResponse) page._uxResponseStart = { selector: nextResponse.selector, t0: Date.now(), initial: await page.locator(nextResponse.selector).last().innerText({ timeout: 200 }).catch(() => "") };
        switch (kind) {
          case "goto":
            await page.goto(cell.base + tpl(s.goto, cell), { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForLoadState("networkidle", { timeout: to }).catch(() => {});
            break;
          case "click": {
            const loc = locatorFor(page, s.click, cell); await checkTarget(loc, cell, args);
            await loc.click({ timeout: to }); break;
          }
          case "fill": requireInteraction(args, true); await locatorFor(page, s.fill, cell).fill(tpl(s.fill.value, cell), { timeout: to }); break;
          case "press": requireInteraction(args, !/^(Tab|Shift\+Tab|Escape|Arrow(Up|Down|Left|Right))$/.test(s.press)); await page.keyboard.press(s.press); break;
          case "select": requireInteraction(args, true); await locatorFor(page, s.select, cell).selectOption(s.select.value, { timeout: to }); break;
          case "check": requireInteraction(args, true); await locatorFor(page, s.check, cell).setChecked(s.check.checked ?? true, { timeout: to }); break;
          case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout: to }); break;
          case "expectURL": await page.waitForURL((u) => u.href === new URL(tpl(s.expectURL, cell), cell.base).href, { timeout: to }); break;
          case "expectVisible": await locatorFor(page, s.expectVisible, cell).waitFor({ state: "visible", timeout: to }); break;
          case "expectHidden": await locatorFor(page, s.expectHidden, cell).waitFor({ state: "hidden", timeout: to }); break;
          case "expectValue": await assertEventually(async () => await locatorFor(page, s.expectValue, cell).inputValue({ timeout: to }) === String(tpl(s.expectValue.value, cell)), to); break;
          case "expectChecked": await assertEventually(async () => await locatorFor(page, s.expectChecked, cell).isChecked() === (s.expectChecked.checked ?? true), to); break;
          case "expectEnabled": await assertEventually(async () => await locatorFor(page, s.expectEnabled, cell).isEnabled() === (s.expectEnabled.enabled ?? true), to); break;
          case "expectCount": await assertEventually(async () => await page.locator(s.expectCount.selector).count() === s.expectCount.count, to); break;
          case "expectAttribute": await assertEventually(async () => await locatorFor(page, s.expectAttribute, cell).getAttribute(s.expectAttribute.attribute) === String(s.expectAttribute.value), to); break;
          case "wait": await page.waitForTimeout(s.wait); break;
          case "waitForText": await page.getByText(tpl(s.waitForText, cell)).first().waitFor({ timeout: to }); break;
          case "measureResponse": rec.response = await measureResponse(page, s.measureResponse);
            if (rec.response.timedOut) throw new Error("no visible response within timeout"); break;
          case "expectText": {
            const need = [].concat(s.expectText).flatMap((t) => (t === "{{persona.mustSee}}" ? cell.persona.mustSee || [] : [tpl(t, cell)]));
            if (!need.length || need.some((t) => !String(t).trim())) throw new Error("Empty expected text assertion");
            await assertEventually(async () => { const body = await visibleText(page); return need.every((t) => body.toLowerCase().includes(t.toLowerCase())); }, to);
            break;
          }
          case "expectNoText": {
            const bad = [].concat(s.expectNoText).flatMap((t) => (t === "{{persona.mustNotSee}}" ? cell.persona.mustNotSee || [] : [tpl(t, cell)]));
            if (!bad.length || bad.some((t) => !String(t).trim())) throw new Error("Empty forbidden-text assertion");
            const html = await visibleText(page);
            const found = bad.filter((t) => {
              const pre = /^\w/.test(t) ? "\\b" : "", post = /\w$/.test(t) ? "\\b" : "";
              return new RegExp(pre + esc(t) + post, "i").test(html);
            });
            if (found.length) { rec.leak = found; throw new Error("must NOT be visible but is: " + found.join(", ")); }
            break;
          }
          case "screenshot": break;
          default: throw new Error("unknown step " + kind);
        }
      } catch (e) {
        rec.ok = false; rec.error = String(e.message).split("\n")[0].slice(0, 200);
        if (!s.optional && !["expectText", "expectNoText"].includes(kind)) broken = true;
      }
      rec.ms = Date.now() - t0;
      if (s.shot !== false) {
        await page.waitForTimeout(300);
        const f = `${String(i).padStart(2, "0")}_${slugify(kind + "_" + (typeof s[kind] === "string" ? s[kind] : s[kind]?.name || s[kind]?.label || s[kind]?.text || ""))}.png`;
        const masks = cell.mask.map((m) => page.locator(m));
        try {
          await page.screenshot({ path: path.join(dir, f), fullPage: false, mask: masks, animations: "disabled" }); rec.shot = f;
        } catch (e) { rec.ok = false; rec.error = `Evidence capture failed: ${e.message}`; }
      }
      steps.push(rec);
    }
    const result = { cell: cell.id, persona: cell.persona.name || cell.persona, partner: cell.partner.name || cell.partner, journey: jid,
      title: journey.title, viewport: cell.viewport, network: cell.network, passed: steps.every((s) => s.ok || !s.required) && steps.some((s) => s.kind?.startsWith("expect") && s.ok && s.required) && !sink.console.length && !context._uxBlocked.length,
      assertions: steps.filter((s) => s.kind?.startsWith("expect") && s.ok).length,
      acceptanceNote: "At least one required explicit acceptance assertion must pass; action-only scripts are not UAT acceptance.",
      blockedRequests: context._uxBlocked,
      totalMs: Date.now() - jStart, steps, consoleErrors: sink.console.slice(0, 20), failedRequests: sink.failed.slice(0, 20) };

    if (args.compare) {
      const bdir = path.join(args.compare, cell.slug, "journeys", jid);
      const bfile = path.join(bdir, "result.json");
      const regressions = [];
      if (!fs.existsSync(bfile)) regressions.push({ type: "no-baseline" });
      else {
        const base = JSON.parse(fs.readFileSync(bfile, "utf8"));
        if (base.steps.length !== steps.length) regressions.push({ type: "step-count-changed" });
        for (const st of steps) {
          const bs = base.steps[st.i];
          if (!bs) { regressions.push({ type: "baseline-step-missing", step: st.i }); continue; }
          if (st.shot && (!bs.shot || !fs.existsSync(path.join(bdir, bs.shot)))) regressions.push({ type: "missing-baseline-evidence", step: st.i });
          if (bs.ok && !st.ok) regressions.push({ type: st.leak ? "leak" : "broken", step: st.i, kind: st.kind, error: st.error });
          if (bs.ms > 200 && st.ms > bs.ms * SLOW_F && st.ms - bs.ms > 1000) regressions.push({ type: "slower", step: st.i, kind: st.kind, before: bs.ms, after: st.ms });
          if (bs.response?.firstOutputMs && st.response?.firstOutputMs > bs.response.firstOutputMs * SLOW_F)
            regressions.push({ type: "slower-response", step: st.i, before: bs.response.firstOutputMs, after: st.response.firstOutputMs });
          if (st.shot && bs.shot && fs.existsSync(path.join(bdir, bs.shot)) && fs.existsSync(path.join(dir, st.shot))) {
            const d = await visualDiff(helper, path.join(bdir, bs.shot), path.join(dir, st.shot), path.join(dir, st.shot.replace(".png", "_diff.png")));
            st.visualDiff = d;
            if (d.ratio > DIFF_T || d.sizeChanged) regressions.push({ type: "visual-change", step: st.i, kind: st.kind, ratio: d.ratio, diff: st.shot.replace(".png", "_diff.png") });
          }
        }
      }
      result.regressions = regressions;
      if (regressions.length) result.passed = false;
    }
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    allResults.push(result);
    const failed = steps.filter((s) => !s.ok && !s.skipped);
    console.log(`[${cell.id}] ${jid}: ${result.passed ? "PASS" : "FAIL"} in ${result.totalMs}ms` +
      (failed.length ? ` · failed: ${failed.map((f) => `#${f.i} ${f.kind} (${f.error})`).join("; ")}` : "") +
      (result.regressions ? ` · regressions: ${result.regressions.length}` : ""));
    await page.close();
  }
  await context.close();
}
ensureDir(OUT);
fs.writeFileSync(path.join(OUT, baselineMode ? "baseline_summary.json" : "journeys_summary.json"), JSON.stringify(allResults.map((r) => ({
  cell: r.cell, journey: r.journey, passed: r.passed, totalMs: r.totalMs, regressions: r.regressions?.length ?? null,
  leaks: r.steps.filter((s) => s.leak).flatMap((s) => s.leak) })), null, 2));
} finally { await browser.close(); }
if (!allResults.length || allResults.some((r) => !r.passed)) process.exitCode = args.compare ? 2 : 1;
