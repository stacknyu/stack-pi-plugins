/** In-page DOM observer: remounts of DOM elements, text flaps, layout shifts, running animations. Installed before app scripts. */
export function DOM_OBSERVER() {
  if (window.__gl) return;
  const G = (window.__gl = { events: [], shifts: [], anim: [] });
  // hide the blinking text caret so it isn't reported as flicker
  const hideCaret = () => { const st = document.createElement("style"); st.textContent = "*{caret-color:transparent!important}"; (document.head || document.documentElement).appendChild(st); };
  if (document.head) hideCaret(); else document.addEventListener("DOMContentLoaded", hideCaret, { once: true });
  const now = () => Math.round(performance.now());
  const desc = (el) => {
    if (!el || !el.tagName) return "?";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const tid = el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.getAttribute("role");
    if (tid) s += `[${tid}]`;
    else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50);
    return t ? `${s} "${t}"` : s;
  };
  const sig = (el) => el.tagName + "|" + (typeof el.className === "string" ? el.className : "") + "|" + (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const rect = (el) => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } };
  const removed = []; // {sig, t, desc, rect}
  const lastRect = new WeakMap();
  const textHist = new WeakMap();
  const start = () => {
    const mo = new MutationObserver((muts) => {
      const t = now();
      for (const m of muts) {
        if (m.type === "childList") {
          m.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const r = lastRect.get(n);
            if (!r || r.w < 40 || r.h < 16) return;
            removed.push({ sig: sig(n), t, desc: desc(n), rect: r });
          });
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            requestAnimationFrame(() => {
              const r = rect(n); if (!r || r.w < 40 || r.h < 16) return;
              lastRect.set(n, r);
              n.querySelectorAll?.("*").forEach((c) => { const cr = rect(c); if (cr && cr.w >= 40 && cr.h >= 16) lastRect.set(c, cr); });
              const s = sig(n);
              const hit = removed.findLast?.((x) => x.sig === s && t - x.t < 1500);
              if (hit) G.events.push({ type: "remount", t, desc: desc(n), rect: r, gapMs: t - hit.t });
            });
          });
        }
        const el = m.type === "characterData" ? m.target.parentElement : m.target.nodeType === 1 ? m.target : null;
        if (el && (m.type === "characterData" || m.type === "childList")) {
          const txt = el.innerText || "";
          if (txt.length > 300) continue;
          const h = textHist.get(el) || [];
          if (!h.length) {
            // seed with the value before this mutation, so the first change is visible in history
            let old = null;
            if (m.type === "characterData") old = m.oldValue;
            else if ([...m.removedNodes].every((n) => n.nodeType === 3) && [...m.addedNodes].every((n) => n.nodeType === 3) && m.removedNodes.length)
              old = txt.replace([...m.addedNodes].map((n) => n.textContent).join(""), [...m.removedNodes].map((n) => n.textContent).join(""));
            if (old !== null && old !== txt) h.push({ v: old.slice(0, 300), t: t - 1 });
          }
          const changed = !h.length || h[h.length - 1].v !== txt;
          if (changed) h.push({ v: txt, t });
          while (h.length > 6) h.shift();
          textHist.set(el, h);
          const n = h.length;
          if (changed && n >= 3 && h[n - 1].v === h[n - 3].v && h[n - 2].v !== h[n - 1].v && t - h[n - 2].t < 2000 && (h[n - 1].v || h[n - 2].v))
            G.events.push({ type: "text-flap", t, visibleMs: t - h[n - 2].t, desc: desc(el), rect: rect(el), sequence: [h[n - 3].v, h[n - 2].v, h[n - 1].v].map((s) => s.slice(0, 60)) });
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    // seed rects for existing elements periodically so removals can be sized
    const seed = () => {
      document.querySelectorAll("body *").forEach((c) => { const r = rect(c); if (r && r.w >= 40 && r.h >= 16) lastRect.set(c, r); });
      // remember where intentional animations run (spinners, typing dots, pulses)
      try {
        for (const a of document.getAnimations()) {
          const el = a.effect?.target; if (!el || a.playState !== "running") continue;
          const r = rect(el); if (!r || !r.w) continue;
          G.anim.push({ ...r, t: now(), desc: desc(el) });
          if (G.anim.length > 1000) G.anim.shift();
        }
      } catch {}
    };
    setInterval(seed, 250);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          G.shifts.push({ t: Math.round(e.startTime), value: +e.value.toFixed(4),
            sources: (e.sources || []).map((s) => ({ desc: desc(s.node), from: s.previousRect && { x: s.previousRect.x, y: s.previousRect.y, w: s.previousRect.width, h: s.previousRect.height }, to: s.currentRect && { x: s.currentRect.x, y: s.currentRect.y, w: s.currentRect.width, h: s.currentRect.height } })) });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  };
  if (document.documentElement) start(); else document.addEventListener("readystatechange", start, { once: true });
}
