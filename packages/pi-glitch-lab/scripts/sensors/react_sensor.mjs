/**
 * React render sensor — runs inside the page, installed before any app script.
 *
 * It registers itself as (or wraps) window.__REACT_DEVTOOLS_GLOBAL_HOOK__, the same channel React DevTools
 * uses, and on every commit records which components MOUNTED, RE-RENDERED or were REMOVED, where they sit on
 * screen, and which props changed. From that it derives REMOUNTS: a component that is removed and a new
 * instance of the same component appears in the same place (e.g. a sidebar rebuilt on every navigation,
 * a chat box whose component type changes on every render).
 *
 * Works on production builds too, but component names are minified there (e.g. "a", "Xe"); a staging
 * build with readable names gives much better reports.
 *
 * Data: window.__glReact = { available, commits, events: [...], counts }
 *   event: { type: "mount"|"render"|"unmount"|"remount", t, name, rect, changed?, gapMs? }
 */
export function REACT_SENSOR() {
  if (window.__glReact) return;
  const S = (window.__glReact = { available: false, renderers: 0, commits: 0, events: [], dropped: 0, lastRect: new WeakMap() });
  const MAX_EVENTS = 20000, MAX_VISIT = 5000, MAX_RECTS = 120;
  const COMPOSITE = new Set([0, 1, 2, 11, 14, 15]); // Function, Class, Indeterminate, ForwardRef, Memo, SimpleMemo
  const HOST = new Set([5, 26, 27]);                  // HostComponent, HostHoistable, HostSingleton
  const push = (e) => { if (S.events.length < MAX_EVENTS) S.events.push(e); else S.dropped++; };

  const nameOf = (type) => {
    if (!type || typeof type === "string") return null;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (type.displayName) return type.displayName;
    if (type.render) return type.render.displayName || type.render.name || null;
    if (type.type) return nameOf(type.type);
    return null;
  };
  let lastHops = 0;
  const hostOf = (fiber) => {
    let f = fiber, depth = 0;
    while (f && depth++ < 60) {
      if (HOST.has(f.tag) && f.stateNode && f.stateNode.getBoundingClientRect) { lastHops = depth; return f.stateNode; }
      f = f.child;
    }
    return null;
  };
  let rectBudget = 0;
  const rectOf = (fiber) => {
    if (rectBudget-- <= 0) return null;
    const el = hostOf(fiber);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    // d = hops from the component to its first DOM element: wrappers that share the same element have a larger d
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), d: lastHops };
  };
  const changedProps = (prev, next) => {
    if (!prev || !next || prev === next) return [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const out = [];
    for (const k of keys) if (k !== "children" && prev[k] !== next[k]) out.push(k);
    if (prev.children !== next.children && out.length === 0) out.push("children");
    return out.slice(0, 6);
  };
  // did any hook VALUE change? (hook objects are new on every render, so compare their values;
  // effect hooks hold new effect objects each render and are ignored)
  const isEffect = (v) => v && typeof v === "object" && "create" in v && "deps" in v;
  const stateChanged = (fiber) => {
    const a = fiber.alternate.memoizedState, b = fiber.memoizedState;
    if (fiber.tag === 1) return a !== b;            // class component: new state object on setState
    let x = a, y = b, n = 0;
    while (x && y && n++ < 80) {
      if (typeof x !== "object" || typeof y !== "object" || !("next" in x)) return x !== y;
      if (x.memoizedState !== y.memoizedState && !(isEffect(x.memoizedState) && isEffect(y.memoizedState))) return true;
      x = x.next; y = y.next;
    }
    return false;
  };
  const collectDeleted = (fiber, into, now) => {
    // walk a deleted subtree and record composite components that went away
    const stack = [fiber]; let n = 0;
    while (stack.length && n++ < 800) {
      const f = stack.pop(); if (!f) continue;
      if (COMPOSITE.has(f.tag) && !reported.has(f) && !(f.alternate && reported.has(f.alternate))) {
        reported.add(f);
        const name = nameOf(f.type);
        if (name) into.push({ name, rect: S.lastRect.get(f) || (f.alternate && S.lastRect.get(f.alternate)) || null, t: now });
      }
      if (f.child) stack.push(f.child);
      if (f.sibling && f !== fiber) stack.push(f.sibling);
    }
  };

  const recent = []; // recently removed composites: {name, rect, t}
  const reported = new WeakSet(); // fibers already reported as removed (React may report via two channels)
  const overlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  function onCommit(root) {
    const now = Math.round(performance.now());
    S.commits++;
    rectBudget = MAX_RECTS;
    const current = root && root.current;
    if (!current) return;
    const removed = [];
    const mounts = [];
    let visited = 0;
    const walk = (fiber, mounting) => {
      const stack = [[fiber, mounting]];
      while (stack.length) {
        const [f, isMount] = stack.pop();
        if (!f || visited++ > MAX_VISIT) continue;
        if (f.deletions && f.deletions.length) for (const d of f.deletions) collectDeleted(d, removed, now);
        const composite = COMPOSITE.has(f.tag);
        const name = composite ? nameOf(f.type) : null;
        let descend = true;
        if (isMount || !f.alternate) {
          if (name) { const rect = rectOf(f); if (rect) S.lastRect.set(f, rect); mounts.push({ name, rect }); push({ type: "mount", t: now, name, rect }); }
          if (f.child) stack.push([f.child, true]);
        } else {
          if (name && ((f.flags ?? f.effectTag ?? 0) & 1) === 1) { // PerformedWork => this component rendered in this commit
            const rect = rectOf(f); if (rect) S.lastRect.set(f, rect);
            const ch = changedProps(f.alternate.memoizedProps, f.memoizedProps);
            const why = ch.length ? ch : stateChanged(f) ? ["(own state)"] : ["(parent re-rendered)"];
            push({ type: "render", t: now, name, rect, changed: why });
          }
          // only descend where React actually re-processed children
          descend = f.child !== f.alternate.child || !!(f.deletions && f.deletions.length);
          // (flags on skipped subtrees are stale, so never descend into them)
          if (f.child && descend) stack.push([f.child, false]);
        }
        if (f.sibling && f !== fiber) stack.push([f.sibling, isMount]);
      }
    };
    try { walk(current, false); } catch (e) { S.error = String(e && e.message); }
    for (const r of removed) { push({ type: "unmount", t: now, name: r.name, rect: r.rect }); recent.push(r); }
    // remount = same component name removed and mounted again in (about) the same place within 2s
    while (recent.length && now - recent[0].t > 2000) recent.shift();
    for (const m of mounts) {
      const idx = recent.findIndex((r) => r.name === m.name && (!r.rect || !m.rect || overlap(r.rect, m.rect)));
      if (idx >= 0) { const r = recent.splice(idx, 1)[0]; push({ type: "remount", t: now, name: m.name, rect: m.rect || r.rect, gapMs: now - r.t }); }
    }
  }
  function onUnmount(fiber) {
    if (!COMPOSITE.has(fiber.tag) || reported.has(fiber) || (fiber.alternate && reported.has(fiber.alternate))) return;
    reported.add(fiber);
    const name = nameOf(fiber.type); if (!name) return;
    const now = Math.round(performance.now());
    const rect = S.lastRect.get(fiber) || (fiber.alternate && S.lastRect.get(fiber.alternate)) || null;
    recent.push({ name, rect, t: now }); push({ type: "unmount", t: now, name, rect });
  }

  const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && typeof existing === "object") {
    const oc = existing.onCommitFiberRoot, ou = existing.onCommitFiberUnmount;
    existing.onCommitFiberRoot = function (id, root, ...rest) { try { S.available = true; onCommit(root); } catch {} return oc && oc.call(this, id, root, ...rest); };
    existing.onCommitFiberUnmount = function (id, fiber, ...rest) { try { onUnmount(fiber); } catch {} return ou && ou.call(this, id, fiber, ...rest); };
    return;
  }
  let nextId = 0;
  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) { const id = ++nextId; this.renderers.set(id, renderer); S.renderers++; S.available = true; return id; },
    onCommitFiberRoot(_id, root) { try { onCommit(root); } catch (e) { S.error = String(e && e.message); } },
    onCommitFiberUnmount(_id, fiber) { try { onUnmount(fiber); } catch {} },
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true, writable: true });
}
