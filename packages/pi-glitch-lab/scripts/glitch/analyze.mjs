import fs from "node:fs";
import path from "node:path";

// ---------------- analysis helpers (run inside a blank helper page) ----------------
const SUB = 4; // each grid block is compared as SUB×SUB sub-cells so small text changes register
export async function blockSignatures(helper, frames, cols) {
  return helper.evaluate(async ({ frames, cols, SUB }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
    const out = [];
    for (const f of frames) {
      const im = await load("data:image/png;base64," + f.data);
      if (!im) { out.push(null); continue; }
      const rows = Math.max(1, Math.round((cols * im.height) / im.width));
      const W = cols * SUB, H = rows * SUB;
      const c = new OffscreenCanvas(W, H), x = c.getContext("2d");
      x.imageSmoothingQuality = "high"; x.drawImage(im, 0, 0, W, H);
      out.push({ w: im.width, h: im.height, rows, px: Array.from(x.getImageData(0, 0, W, H).data) });
    }
    return out;
  }, { frames, cols, SUB });
}

export async function composite(helper, panels, file, opts = {}) {
  // panels: [{data, label, boxes:[{x,y,w,h}] (in image px)}]
  const png = await helper.evaluate(async ({ panels, opts }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const ims = await Promise.all(panels.map((p) => load("data:image/png;base64," + p.data)));
    const tw = opts.thumbW || 360, scale = tw / ims[0].width, th = Math.round(ims[0].height * scale);
    const per = opts.perRow || panels.length, rows = Math.ceil(panels.length / per);
    const c = new OffscreenCanvas(per * (tw + 12) + 12, rows * (th + 34) + 12), x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    panels.forEach((p, i) => {
      const cx = 12 + (i % per) * (tw + 12), cy = 12 + Math.floor(i / per) * (th + 34);
      x.fillStyle = "#111"; x.font = "bold 14px sans-serif"; x.fillText(p.label, cx, cy + 14);
      x.drawImage(ims[i], cx, cy + 22, tw, th);
      x.strokeStyle = "#ccc"; x.lineWidth = 1; x.strokeRect(cx, cy + 22, tw, th);
      x.strokeStyle = "#e11d48"; x.lineWidth = 3;
      for (const b of p.boxes || []) x.strokeRect(cx + b.x * scale, cy + 22 + b.y * scale, b.w * scale, b.h * scale);
    });
    const blob = await c.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { panels, opts });
  fs.writeFileSync(file, Buffer.from(png, "base64"));
}

const px = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
/** Max sub-cell difference inside grid block `blk` (block index), for frames with `cols` blocks per row. */
export function blockDiff(A, B, blk, cols) {
  const r = Math.floor(blk / cols), c = blk % cols, W = cols * SUB;
  let m = 0;
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) {
    const i = ((r * SUB + dy) * W + (c * SUB + dx)) * 4;
    const d = px(A.px, B.px, i); if (d > m) m = d;
  }
  return m;
}
/** fraction of the smaller rect covered by the intersection */
export const overlapFrac = (a, b) => {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h)) : 0;
};
export const overlaps = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function groupBlocks(blocks, cols) {
  // blocks: Set of indices -> connected components -> bounding boxes in grid units
  const seen = new Set(), comps = [];
  for (const b of blocks) {
    if (seen.has(b)) continue;
    const stack = [b], comp = []; seen.add(b);
    while (stack.length) {
      const k = stack.pop(); comp.push(k);
      const r = Math.floor(k / cols), c = k % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const n = (r + dr) * cols + (c + dc);
        if (c + dc >= 0 && c + dc < cols && blocks.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    const rs = comp.map((k) => Math.floor(k / cols)), cs = comp.map((k) => k % cols);
    comps.push({ r0: Math.min(...rs), r1: Math.max(...rs), c0: Math.min(...cs), c1: Math.max(...cs), n: comp.length });
  }
  return comps;
}

export async function analyzeScenario({ helper, frames, dom, viewport, ignoreRects, targetRect, kind, dir, name, grid = 24 }) {
  const GRID = grid;
  const res = { scenario: name, kind, frames: frames.length, glitches: [] };
  if (frames.length < 3) { res.note = "too few painted frames to analyze"; }
  if (process.env.GLITCH_DEBUG) frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `${name}_raw_${String(i).padStart(2, "0")}_${f.t}ms.png`), Buffer.from(f.data, "base64")));
  const sigs = frames.length ? await blockSignatures(helper, frames, GRID) : [];
  const valid = sigs.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const first = sigs[valid[0]];
  const T = (i) => frames[i].t;
  const imgToCss = first ? viewport.width / first.w : 1;
  const blockRect = (g) => ({ x: Math.round((g.c0 * first.w) / GRID), y: Math.round((g.r0 * first.h) / first.rows),
    w: Math.round(((g.c1 - g.c0 + 1) * first.w) / GRID), h: Math.round(((g.r1 - g.r0 + 1) * first.h) / first.rows) });
  const toCss = (r) => ({ x: Math.round(r.x * imgToCss), y: Math.round(r.y * imgToCss), w: Math.round(r.w * imgToCss), h: Math.round(r.h * imgToCss) });
  const ignored = (cssR) => ignoreRects.some((ir) => overlaps(ir, cssR));
  const TH = 90; // per-pixel RGB sum difference for a sub-cell to count as changed

  if (first && valid.length >= 3) {
    const nB = GRID * first.rows;
    // --- flicker: per block, a change followed by a change back within 600ms (A -> B -> A)
    const flickerEvents = [];
    const groups = new Map(); // "i,j,k" -> Set(blocks)
    for (let b = 0; b < nB; b++) {
      const changes = []; // valid-list positions where this block changed vs previous frame
      for (let v = 1; v < valid.length; v++) {
        const P = sigs[valid[v - 1]], Q = sigs[valid[v]];
        if (P.rows === Q.rows && blockDiff(P, Q, b, GRID) > TH) changes.push(v);
      }
      for (let c = 0; c + 1 < changes.length; c++) {
        const vj = changes[c], vk = changes[c + 1];
        const i = valid[vj - 1], j = valid[vj], k = valid[vk];
        if (T(k) - T(j) > 600 || (kind === "load" && vj - 1 === 0)) continue; // B must be brief; never compare against the very first (often blank) paint
        if (blockDiff(sigs[i], sigs[k], b, GRID) < 30) {
          const key = `${i},${j},${k}`;
          if (!groups.has(key)) groups.set(key, new Set());
          groups.get(key).add(b);
        }
      }
    }
    for (const [key, set] of groups) {
      const [i, j, k] = key.split(",").map(Number);
      for (const g of groupBlocks(set, GRID)) {
        const r = blockRect(g), css = toCss(r);
        if (ignored(css)) continue;
        flickerEvents.push({ type: "flicker", t: T(j), visibleMs: T(k) - T(j), before: T(i), back: T(k), img: r, css, frames: [i, j, k], areaPct: +((100 * g.n) / nB).toFixed(1) });
      }
    }
    flickerEvents.sort((x, y) => x.t - y.t);
    res.glitches.push(...flickerEvents);

    // --- settle time & late changes (page loads only)
    let settleIdx = null;
    for (let vi = 1; vi < valid.length; vi++) {
      const prevT = T(valid[vi - 1]), curT = T(valid[vi]);
      if (curT - prevT >= 1000 && T(valid[vi - 1]) > 300) { settleIdx = valid[vi - 1]; break; }
    }
    res.settledAtMs = settleIdx !== null ? T(settleIdx) : null;
    if (kind === "load" && settleIdx !== null) {
      let base = settleIdx;
      for (const i of valid.filter((i) => i > settleIdx)) {
        const set = new Set();
        for (let b = 0; b < nB; b++) if (blockDiff(sigs[base], sigs[i], b, GRID) > TH) set.add(b);
        for (const g of groupBlocks(set, GRID)) {
          const r = blockRect(g), css = toCss(r);
          if (ignored(css) || g.n < 2) continue;
          res.glitches.push({ type: "late-change", t: T(i), afterSettleMs: T(i) - T(settleIdx), img: r, css, frames: [base, i], areaPct: +((100 * g.n) / nB).toFixed(1) });
        }
        base = i;
      }
    }
    // --- interactions: changes far from what the user touched, beyond the main update
    if (kind === "interaction" && targetRect) {
      const last = valid[valid.length - 1];
      for (const i of valid.slice(1)) if (T(i) > 1500) {
        const prev = valid[valid.indexOf(i) - 1];
        const set = new Set();
        for (let b = 0; b < nB; b++) if (blockDiff(sigs[prev], sigs[i], b, GRID) > TH) set.add(b);
        for (const g of groupBlocks(set, GRID)) {
          const r = blockRect(g), css = toCss(r);
          if (ignored(css) || g.n < 2 || overlaps(css, targetRect)) continue;
          res.glitches.push({ type: "late-change", t: T(i), note: ">1.5s after the interaction, away from the touched element", img: r, css, frames: [prev, i], areaPct: +((100 * g.n) / nB).toFixed(1) });
        }
      }
    }
  }

  // label glitches inside elements that run CSS/Web animations as probably intentional
  for (const g of res.glitches) {
    const a = (dom.anim || []).find((r) => g.css && Math.abs(r.t - g.t) <= 300 &&
      Math.max(0, Math.min(r.x + r.w, g.css.x + g.css.w) - Math.max(r.x, g.css.x)) *
      Math.max(0, Math.min(r.y + r.h, g.css.y + g.css.h) - Math.max(r.y, g.css.y)) >= 0.8 * g.css.w * g.css.h);
    if (a) { g.probablyIntentional = true; g.note = ((g.note ? g.note + "; " : "") + `inside an animated element (${a.desc})`); }
  }

  // a late change that is really one half of a flicker is reported once, as the flicker
  const fl = res.glitches.filter((g) => g.type === "flicker");
  res.glitches = res.glitches.filter((g) => g.type !== "late-change" || !fl.some((f) => overlaps(f.css, g.css) && g.t >= f.t - 50 && g.t <= f.back + 50));
  fl.forEach((f) => { if (f.t > (res.settledAtMs ?? Infinity)) f.note = "happened after the page looked finished"; });

  // --- DOM evidence
  for (const e of dom.events || []) {
    if (e.rect && ignored(e.rect)) continue;
    res.glitches.push({ ...e, css: e.rect });
  }
  const shifts = (dom.shifts || []).filter((s) => s.value >= 0.005);
  res.cls = +(dom.shifts || []).reduce((a, s) => a + s.value, 0).toFixed(3);
  for (const s of shifts) res.glitches.push({ type: "layout-shift", t: s.t, value: s.value, sources: s.sources, css: s.sources?.[0]?.to });

  // attach likely DOM culprit to visual glitches
  for (const g of res.glitches.filter((g) => g.type === "flicker" || g.type === "late-change")) {
    const cands = (dom.events || []).filter((e) => e.rect && overlapFrac(e.rect, g.css) > 0.2).map((e) => `${e.type}: ${e.desc}`);
    if (cands.length) g.likelyElements = [...new Set(cands)].slice(0, 3);
  }

  // images
  if (frames.length) {
    const step = Math.max(1, Math.ceil(frames.length / 24));
    const film = frames.filter((_, i) => i % step === 0).slice(0, 24).map((f) => ({ data: f.data, label: `${f.t} ms` }));
    await composite(helper, film, path.join(dir, `${name}_filmstrip.png`), { thumbW: 220, perRow: 6 });
    let n = 0;
    for (const g of res.glitches) {
      if (!g.frames && valid.length) {
        const at = (t) => valid.reduce((best, i) => Math.abs(frames[i].t - t) < Math.abs(frames[best].t - t) ? i : best, valid[0]);
        g.frames = [at(g.t - (g.visibleMs || g.gapMs || 0) - 50), at(g.t + 50)];
        g.note = [g.note, "Sampled surrounding frames; the transient itself may not have been captured"].filter(Boolean).join("; ");
        if (g.css) g.img = { x: g.css.x / imgToCss, y: g.css.y / imgToCss, w: g.css.w / imgToCss, h: g.css.h / imgToCss };
      }
      if (!g.frames) continue;
      n++;
      const labels = g.type === "flicker" ? ["before", "glitch", "after"] : ["before", "after"];
      const panels = g.frames.map((fi, j) => ({ data: frames[fi].data, label: `${labels[j]} · ${frames[fi].t} ms`, boxes: g.img ? [g.img] : [] }));
      g.image = `${name}_glitch_${String(n).padStart(2, "0")}.png`;
      await composite(helper, panels, path.join(dir, g.image), { thumbW: 380 });
      delete g.frames; delete g.img;
    }
  }
  Object.defineProperty(res, "_sigs", { value: sigs, enumerable: false });
  Object.defineProperty(res, "_valid", { value: valid, enumerable: false });
  res.imgToCss = +imgToCss.toFixed(4);
  res.counts = res.glitches.reduce((a, g) => { const k = g.probablyIntentional ? g.type + "(animated)" : g.type; a[k] = (a[k] || 0) + 1; return a; }, {});
  return res;
}

export async function record(page, fn, watchMs) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const ts = f.metadata.timestamp * 1000;
    frames.push({ data: f.data, ts, wall: Date.now() });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = page.viewportSize();
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: Math.min(vp.width, 900), maxHeight: 2000, everyNthFrame: 1 });
  const startWall = Date.now();
  try {
    await fn();
    await page.waitForTimeout(watchMs);
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  // frames can arrive out of order: sort by capture timestamp, then re-base on action start
  frames.sort((a, b) => a.ts - b.ts);
  if (frames.length) {
    const tsMin = frames[0].ts, wallMin = Math.min(...frames.map((f) => f.wall));
    const off = wallMin - startWall - (frames.find((f) => f.wall === wallMin).ts - tsMin);
    frames.forEach((f) => (f.t = Math.max(0, Math.round(f.ts - tsMin + off))));
  }
  return frames;
}

export async function ignoreRectsFor(page, cell) {
  if (!cell.mask?.length) return [];
  return page.evaluate((sels) => sels.flatMap((s) => { try { return [...document.querySelectorAll(s)]; } catch { return []; } })
    .map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }), cell.mask).catch(() => []);
}

/** Fraction (0..1) of grid blocks inside cssRect that differ between two analyzed frames (by index). */
export function regionChange(res, iA, iB, cssRect, grid = 24) {
  const sigs = res._sigs; if (!sigs || !sigs[iA] || !sigs[iB] || !cssRect) return null;
  const A = sigs[iA], B = sigs[iB]; if (A.rows !== B.rows) return null;
  const k = 1 / (res.imgToCss || 1);
  const bw = A.w / grid, bh = A.h / A.rows;
  const c0 = Math.max(0, Math.floor((cssRect.x * k) / bw)), c1 = Math.min(grid - 1, Math.floor(((cssRect.x + cssRect.w) * k - 1) / bw));
  const r0 = Math.max(0, Math.floor((cssRect.y * k) / bh)), r1 = Math.min(A.rows - 1, Math.floor(((cssRect.y + cssRect.h) * k - 1) / bh));
  let n = 0, ch = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { n++; if (blockDiff(A, B, r * grid + c, grid) > 90) ch++; }
  return n ? ch / n : null;
}
