#!/usr/bin/env node
/**
 * report.mjs — one shareable HTML report from Glitch Lab runs, journeys, affordance scans and Claude's findings.
 *
 *   node report.mjs <run-dir> [--findings .ux/findings.json] [--out .ux/report/index.html] [--embed] [--title "..."]
 *
 * <run-dir> may contain any mix of: glitch lab cells (findings.json + summary.md), journey results
 * (<cell>/journeys/<id>/result.json) and affordance scans (<cell>/affordance/*_affordance.json).
 * --embed inlines images (one self-contained file to share).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib.mjs";

const argv = process.argv.slice(2);
const runDir = path.resolve(argv.find((a) => !a.startsWith("--")) || ".ux");
const args = parseArgs(argv);
const out = path.resolve(args.out || path.join(runDir, "report.html"));
const outDir = path.dirname(out);
fs.mkdirSync(outDir, { recursive: true });
const embed = !!args.embed;
const human = args.findings && fs.existsSync(args.findings) ? JSON.parse(fs.readFileSync(args.findings, "utf8")) : {};

const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const walk = (dir, test, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n); const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, test, acc); else if (test(p)) acc.push(p);
  }
  return acc.sort();
};
const img = (p, cls = "shot") => {
  if (!p || !fs.existsSync(p)) return "";
  const src = embed ? `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` : path.relative(outDir, p);
  return `<a href="${e(src)}" target="_blank" rel="noopener"><img class="${e(cls)}" loading="lazy" src="${e(src)}"></a>`;
};
const SEV = { S1: "#b91c1c", S2: "#c2410c", S3: "#a16207", S4: "#4b5563", high: "#b91c1c", medium: "#c2410c", low: "#4b5563" };
const pill = (t) => `<span class="pill" style="background:${SEV[t] || "#555"}">${e(t)}</span>`;

const P = [];
P.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(human.title || args.title || "UX & glitch audit")}</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#57534e;--card:#fff;--line:#e7e5e4}
@media (prefers-color-scheme: dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--card:#292524;--line:#44403c}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px 20px 80px}h1{margin:0 0 4px;font-size:28px}h2{margin:40px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.mut{color:var(--mut)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;color:#fff;font-size:12px;font-weight:600;margin-right:6px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.shot{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}.big{max-width:100%;border:1px solid var(--line);border-radius:6px;margin-top:8px;background:#fff}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.wrap{overflow-x:auto}.ok{color:#15803d;font-weight:600}.bad{color:#b91c1c;font-weight:600}blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--line);color:var(--mut);font-style:italic}
code{font-size:13px}</style></head><body><main>
<h1>${e(human.title || args.title || "UX & glitch audit")}</h1><div class="mut">${e(human.subtitle || "")} · generated ${new Date().toISOString().slice(0, 10)}</div>`);
if (human.summary) P.push(`<div class="card">${e(human.summary)}</div>`);

if (human.scorecard?.length) {
  const icon = { smooth: "✅ Smooth", friction: "⚠️ Friction", blocked: "❌ Blocked" };
  P.push(`<h2>Persona × journey scorecard</h2><div class="wrap"><table><tr><th>Persona</th><th>Journey</th><th>Result</th><th>Issues</th></tr>`);
  for (const r of human.scorecard) P.push(`<tr><td>${e(r.cell)}</td><td>${e(r.journey)}</td><td>${icon[r.result] || e(r.result)}</td><td>${e((r.issues || []).join(", "))}</td></tr>`);
  P.push(`</table></div>`);
}
if (human.patterns?.length) {
  P.push(`<h2>Patterns to fix first</h2>`);
  for (const p of human.patterns) P.push(`<div class="card"><b>${e(p.title)}</b> <span class="mut">· ${e((p.findings || []).join(", "))}</span><div>${e(p.description)}</div><div><b>Recommendation:</b> ${e(p.recommendation)}</div></div>`);
}
if (human.findings?.length) {
  P.push(`<h2>Findings</h2>`);
  const order = { S1: 0, S2: 1, S3: 2, S4: 3 };
  for (const f of [...human.findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))) {
    const shots = (f.screenshots || []).map((s) => img(path.isAbsolute(s) ? s : path.join(runDir, s), "big")).join("");
    P.push(`<div class="card" id="${e(f.id)}">${pill(f.severity || "S3")}<b>${e(f.id)} · ${e(f.title)}</b> <span class="mut">· ${e(f.category)} · ${e((f.cells || []).join(", "))} · ${e(f.screen || "")}</span>
${f.personaVoice ? `<blockquote>${e(f.personaVoice)}</blockquote>` : ""}<div>${e(f.observation || "")}</div>
${f.evidence ? `<div><b>Evidence:</b> ${e(f.evidence)}</div>` : ""}<div><b>Recommendation:</b> ${e(f.recommendation || "")}</div>${shots}</div>`);
  }
}

// Glitch Lab
const glitchFiles = walk(runDir, (p) => path.basename(p) === "findings.json" && path.resolve(p) !== path.resolve(args.findings || "") && fs.existsSync(path.join(path.dirname(p), "summary.md")));
if (glitchFiles.length) {
  P.push(`<h2>Visual glitches (Glitch Lab)</h2><div class="mut">Detected with frame-by-frame capture, React render tracking, DOM and network sensors, repeated runs on a slowed CPU. Green in repaint frames = area the browser repainted.</div>`);
  for (const gf of glitchFiles) {
    const g = JSON.parse(fs.readFileSync(gf, "utf8")); const d = path.dirname(gf);
    P.push(`<div class="card"><b>${e(g.cell)}</b> <span class="mut">· ${e(g.mode)} · ${g.repeat} runs · CPU ${g.cpu}× · ${e(g.viewport)} · React sensor ${g.meta?.react ? "on" : "off"}</span>`);
    if (g.meta?.errors?.length) P.push(`<div class="bad">INCOMPLETE: ${e(g.meta.errors.join("; "))}</div>`);
    for (const f of (g.findings || []).filter((x) => x.level !== "low")) {
      P.push(`<div style="margin-top:14px">${pill(f.level)}<b>${e(f.id)} · ${e(f.what)}</b> <span class="mut">· ${e(f.seen)}${f.visibleBlink ? " · visible blink" : ""}</span>
${f.note ? `<div class="mut">${e(f.note)}</div>` : ""}${f.why ? `<div>Why it rendered: <code>${e([].concat(f.why).join(", "))}</code></div>` : ""}
${f.network?.length ? `<div>Right after: <code>${e(f.network.join("; "))}</code></div>` : ""}<div class="mut">Where: ${e((f.scenarios || []).slice(0, 5).join("; "))}</div>
${(f.images || []).slice(0, 1).map((i) => img(path.join(d, i), "big")).join("")}${f.paintImage ? img(path.join(d, f.paintImage), "big") : ""}</div>`);
    }
    const low = (g.findings || []).filter((x) => x.level === "low").length;
    if (low) P.push(`<div class="mut" style="margin-top:10px">${low} low-priority item(s) not shown.</div>`);
    if (g.meta?.paint && fs.existsSync(g.meta.paint)) P.push(`<div class="mut">Paint-flashing video: <code>${e(g.meta.paint)}</code></div>`);
    P.push(`</div>`);
  }
}

// Journeys
const journeys = walk(runDir, (p) => p.endsWith(`${path.sep}result.json`) && p.includes(`${path.sep}journeys${path.sep}`));
if (journeys.length) {
  P.push(`<h2>Journeys</h2>`);
  for (const rp of journeys) {
    const r = JSON.parse(fs.readFileSync(rp, "utf8")); const d = path.dirname(rp);
    P.push(`<div class="card"><b>${e(r.cell)} — ${e(r.title || r.journey)}</b> ${r.passed ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'} <span class="mut">· ${e(r.viewport)} · ${e(r.network)} · ${((r.totalMs || 0) / 1000).toFixed(1)}s</span>`);
    if (r.regressions?.length) P.push(`<div class="bad">Regressions: ${e(r.regressions.map((g) => `${g.type} at step ${g.step ?? "-"}${g.error ? ` (${g.error})` : ""}`).join("; "))}</div>`);
    P.push(`<div class="wrap"><table><tr><th>#</th><th>Step</th><th>Result</th><th>Time</th><th>Notes</th></tr>`);
    for (const s of r.steps || []) {
      let note = s.error || "";
      if (s.response) note = `first output ${s.response.firstOutputMs} ms, complete ${s.response.completeMs} ms`;
      if (s.visualDiff) note += ` · visual change ${(s.visualDiff.ratio * 100).toFixed(2)}%`;
      const arg = typeof s.arg === "string" ? s.arg : JSON.stringify(s.arg);
      P.push(`<tr><td>${s.i}</td><td>${e(s.kind)} ${e(String(arg).slice(0, 90))}</td><td>${s.skipped ? "skipped" : s.ok ? "✅" : "❌"}</td><td>${s.ms ?? ""} ms</td><td>${e(note)}</td></tr>`);
    }
    P.push(`</table></div><div class="grid" style="margin-top:10px">`);
    for (const s of r.steps || []) if (s.shot) P.push(`<div><div class="mut">#${s.i} ${e(s.kind)}</div>${img(path.join(d, s.shot))}</div>`);
    P.push(`</div></div>`);
  }
}

// Affordance
const scans = walk(runDir, (p) => p.endsWith("_affordance.json"));
if (scans.length) {
  P.push(`<h2>Visual affordance scans</h2><div class="mut">Green = real control · Red = looks clickable but isn't · Orange = clickable but doesn't look it · Purple = unlabeled icon · Yellow = small target</div>`);
  for (const sp of scans) {
    const s = JSON.parse(fs.readFileSync(sp, "utf8")); const c = s.counts || {};
    const clicks = s.clicks || []; const dead = clicks.filter((x) => x.result === "no-observable-response"); const slow = clicks.filter((x) => x.slow);
    P.push(`<div class="card"><b>${e(s.cell)} — ${e(s.screen)}</b> <span class="mut">· ${e(s.viewport)} · load ${s.loadMs} ms · fake ${(c.fake || 0) + (c["fake-icon"] || 0)} · hidden ${c.hidden || 0} · unlabeled ${c.unlabeled || 0} · small ${c.small || 0}${clicks.length ? ` · no observable response ${dead.length}/${clicks.length} · slow ${slow.length}` : ""}</span>
${img(sp.replace("_affordance.json", "_annotated.png"), "big")}</div>`);
    if (s.coverage) {
      const coverage = s.coverage;
      P.push(`<div class="card"><b>Interaction coverage — ${e(s.screen)}</b><div>${e(coverage.exercised)}/${e(coverage.discovered)} control-state pairs exercised across ${e(coverage.states.length)} states; ${e(coverage.actualClicks)} actual click attempts including ${e(coverage.replays?.length || 0)} replays. ${coverage.limited ? "LIMIT REACHED — incomplete exploration." : "Bounded exploration finished."}</div><div>${e(coverage.limitations)}</div><div>${e(JSON.stringify(coverage.counts))}</div><div class="wrap"><table><tr><th>State/control</th><th>Outcome</th><th>Notes</th><th>Evidence</th></tr>`);
      for (const action of coverage.actions) P.push(`<tr><td>${e(action.state)} · ${e(action.text || action.selector)}</td><td>${e(action.result)}</td><td>${e(action.reason || action.errors?.join("; ") || "")}</td><td>${[action.before, action.after].filter(Boolean).map((f) => img(path.join(path.dirname(sp), f))).join("")}</td></tr>`);
      P.push(`</table></div></div>`);
    } else P.push(`<div class="mut">Observation only; no controls exercised.</div>`);
    P.push(`<div class="mut">${e(s.limitations)} ${s.scrollTruncated ? "Scroll limit reached." : ""} ${s.horizontalOverflow ? "Horizontal overflow detected." : ""}</div>`);
  }
}
P.push(`</main></body></html>`);
fs.writeFileSync(out, P.join("\n"));
console.log(`Wrote ${out}`);
