import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optionalText = (description: string) => Type.Optional(Type.String({ description }));
const number = (description: string, max: number) => Type.Optional(Type.Integer({ minimum: 1, maximum: max, description }));
const scope = {
  config: optionalText("Matrix config; default .ux/matrix.json"),
  cell: optionalText("Persona cell; omit for all configured cells"),
  interact: Type.Optional(Type.Boolean({ description: "User authorized browser interactions in a disposable test environment. Never infer this permission." })),
  allowWrites: Type.Optional(Type.Boolean({ description: "User explicitly authorized writes, including login, typing, forms and repeated actions. Requires interact=true." })),
  out: optionalText("New output directory; existing directories are rejected"),
};
const flag = (args: string[], name: string, value: unknown) => {
  if (value === undefined || value === false || value === "") return;
  if (typeof value === "string" && value.startsWith("--")) throw new Error(`Invalid value for ${name}: cannot be another CLI flag`);
  args.push(`--${name}`);
  if (value !== true) args.push(String(value));
};
const target = (args: string[], p: any) => {
  if (p.url) flag(args, "url", p.url);
  else { flag(args, "config", p.config || ".ux/matrix.json"); flag(args, p.cell ? "cell" : "all", p.cell || true); }
};
const output = (p: any, kind: string) => p.out || path.join(".ux", kind, `${Date.now()}-${randomUUID().slice(0, 8)}`);
const result = (text: string, ok: boolean, details: any = {}, images: any[] = []) => ({
  content: [{ type: "text" as const, text: text.slice(0, 10000) + (text.length > 10000 ? "\n…truncated; read the output files." : "") }, ...images],
  details: { ...details, ok }, isError: !ok,
});

export default function (pi: ExtensionAPI) {
  async function authorize(p: any, signal: AbortSignal | undefined, ctx: any) {
    signal?.throwIfAborted();
    if (p.allowWrites && !p.interact) throw new Error("allowWrites requires interact=true");
    if (p.interact && ctx.hasUI && !(await ctx.ui.confirm("Glitch Lab interaction approval", p.allowWrites
      ? "Allow writes and repeated browser interactions against the approved disposable test environment? No rollback is provided."
      : "Allow browser interactions against the approved test environment? HTTP writes are blocked, but GET handlers and page scripts can still have side effects.", { signal }))) throw new Error("Interaction approval declined");
  }
  async function run(script: string, args: string[], signal: AbortSignal | undefined, ctx: any) {
    signal?.throwIfAborted();
    const r = await pi.exec(process.execPath, [path.join(PKG, "scripts", script), ...args], { cwd: ctx.cwd, signal, timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
    return { ...r, ok: r.code === 0 && !r.killed && !r.truncated };
  }
  function policy(args: string[], p: any) { flag(args, "interact", p.interact); flag(args, "allow-writes", p.allowWrites); }

  pi.registerTool({
    name: "glitch_hunt", label: "Glitch hunt", executionMode: "sequential",
    description: "Detect visual flicker, remounts and layout shifts using frame/DOM/React sensors. Navigation/journey modes require explicit interaction authorization. Reports sensor limits and incomplete runs, not universal visual correctness. Output text limited to 10k characters.",
    promptSnippet: "glitch_hunt: evidence-backed flicker, remount and layout-shift testing",
    promptGuidelines: ["Use glitch_hunt for flicker or unstable UI only on approved test targets; never infer interaction/write permission or claim exhaustive coverage."],
    parameters: Type.Object({ ...scope, url: optionalText("Starting URL, instead of config"),
      mode: Type.Optional(Type.Union([Type.Literal("nav"), Type.Literal("idle"), Type.Literal("loads"), Type.Literal("journey")])),
      journey: optionalText("Journey ID"), items: optionalText("Comma-separated navigation link labels"),
      fullMatrix: Type.Optional(Type.Boolean()), repeat: number("Runs per scenario; default 2", 5), cpu: number("CPU slowdown; default 4", 10),
      paint: Type.Optional(Type.Boolean()), idleMs: number("Idle watch milliseconds", 60000), viewport: optionalText("desktop, laptop, iphone, android or tablet"),
      attachImages: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    }),
    async execute(_id, p, signal, _update, ctx) {
      await authorize(p, signal, ctx);
      const out = output(p, "glitch"), args = [p.mode || "nav"];
      target(args, p); policy(args, p);
      for (const k of ["journey", "items", "repeat", "cpu", "paint", "viewport"]) flag(args, k, p[k as keyof typeof p]);
      flag(args, "mode", p.fullMatrix ? "full" : undefined); flag(args, "idle-ms", p.idleMs); flag(args, "out", out);
      const r = await run("glitch_lab.mjs", args, signal, ctx);
      if (!r.ok) return result(`Glitch run failed or incomplete. ${out}\n${r.stderr || r.stdout}`, false, { out });
      const index = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, out, "index.json"), "utf8"));
      const summaries: string[] = [], images: any[] = [];
      for (const cell of index) {
        const dir = path.resolve(ctx.cwd, cell.dir);
        summaries.push(fs.readFileSync(path.join(dir, "summary.md"), "utf8"));
        const data = JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8"));
        for (const finding of data.findings.filter((f: any) => f.level === "high")) {
          const image = finding.paintImage || finding.images?.[0];
          if (image && images.length < (p.attachImages ?? 2)) images.push({ type: "image", data: fs.readFileSync(path.join(dir, image)).toString("base64"), mimeType: "image/png" });
        }
      }
      return result(summaries.join("\n\n") + `\nEvidence: ${out}`, index.length > 0 && index.every((c: any) => c.ok), { out }, images);
    },
  });

  pi.registerTool({
    name: "ux_affordance_scan", label: "UI inventory and interaction coverage", executionMode: "sequential",
    description: "Inventory rendered controls and UX candidates. Default observation only. With probeClicks + interact, explore bounded menu/tab/dialog/navigation states, recording responded/no-observable-response/error/blocked/skipped and before/after evidence. Does not establish business correctness. No automatic form filling. 10k-character output limit.",
    promptSnippet: "ux_affordance_scan: rendered controls, UX candidates and bounded interaction coverage",
    promptGuidelines: ["Use ux_affordance_scan observation first; ask for explicit disposable-environment permission before probeClicks/interact. Report skipped controls and bounds, never 'every button passed'."],
    parameters: Type.Object({ ...scope, url: optionalText("Single starting URL"), probeClicks: Type.Optional(Type.Boolean()),
      viewport: optionalText("desktop, laptop, iphone, android or tablet"), maxActions: number("Maximum attempted actions, default 40", 200),
      maxStates: number("Maximum explored states, default 12", 50), maxPages: number("Maximum visited URLs, default 5", 25),
      maxDepth: number("Maximum state depth, default 4", 8), seconds: number("Exploration budget seconds, default 120", 600),
      observeMs: number("Observation window per action, default 1000ms", 5000),
    }),
    async execute(_id, p, signal, _update, ctx) {
      await authorize(p, signal, ctx);
      const out = output(p, "scan"), args: string[] = [];
      target(args, p); policy(args, p); flag(args, "out", out); flag(args, "probe-clicks", p.probeClicks); flag(args, "viewport", p.viewport);
      for (const [k, v] of Object.entries({ "max-actions": p.maxActions, "max-states": p.maxStates, "max-pages": p.maxPages, "max-depth": p.maxDepth, seconds: p.seconds, "observe-ms": p.observeMs })) flag(args, k, v);
      const r = await run("affordance_scan.mjs", args, signal, ctx);
      return result(`${r.ok ? "Scan completed (not UAT acceptance)." : "Scan failed/incomplete."}\n${r.stdout}\n${r.ok ? "" : r.stderr}\nEvidence and coverage: ${out}`, r.ok, { out });
    },
  });

  pi.registerTool({
    name: "ux_journeys", label: "Scripted UAT journeys", executionMode: "sequential",
    description: "Execute explicit acceptance journeys without AI: navigation, authorized input, reload/persistence and text/URL/visibility/value/checked/enabled/count/attribute assertions. Failed steps, missing journeys, missing baselines and regressions fail. Baseline/output must be new directories. 10k-character output limit.",
    promptSnippet: "ux_journeys: deterministic acceptance journeys and regression comparisons",
    parameters: Type.Object({ ...scope, journey: optionalText("Journey ID; omit for configured journeys"),
      baseline: optionalText("Create baseline in this new directory"), compare: optionalText("Existing baseline to compare against"),
    }),
    async execute(_id, p, signal, _update, ctx) {
      await authorize(p, signal, ctx);
      const out = output(p, "journeys"), args: string[] = [];
      target(args, p); policy(args, p); flag(args, "journey", p.journey);
      flag(args, "baseline", p.baseline); flag(args, "compare", p.compare); flag(args, "out", out);
      const r = await run("journey_runner.mjs", args, signal, ctx);
      return result(`${r.ok ? "Journeys passed their scripted assertions." : "Journeys failed/incomplete; do not report acceptance."}\n${r.stdout}\n${r.ok ? "" : r.stderr}\nEvidence: ${p.baseline || out}`, r.ok, { out: p.baseline || out, code: r.code });
    },
  });

  pi.registerTool({
    name: "ux_report", label: "Build UX report", executionMode: "sequential",
    description: "Build an HTML evidence report, including interaction coverage and UAT failures. Treat reports as private; screenshots may contain application data.",
    parameters: Type.Object({ runDir: Type.String(), findings: optionalText("Written findings JSON"), out: optionalText("Output HTML path"), embed: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, signal, _update, ctx) {
      const args = [p.runDir]; flag(args, "findings", p.findings); flag(args, "out", p.out); flag(args, "embed", p.embed !== false);
      const r = await run("report.mjs", args, signal, ctx);
      return result(r.stdout + r.stderr, r.ok);
    },
  });

  async function doctor(install: boolean, signal: AbortSignal | undefined, ctx: any) {
    signal?.throwIfAborted();
    if (install) {
      const r = await pi.exec(process.execPath, [path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"), "install", "chromium"], { cwd: PKG, signal, timeout: 180000 });
      if (r.code !== 0 || r.killed || r.truncated) return result(r.stderr || r.stdout, false);
    }
    const r = await run("doctor.mjs", [], signal, ctx);
    return result(r.stdout + r.stderr, r.ok);
  }
  pi.registerTool({
    name: "glitch_lab_doctor", label: "Glitch Lab doctor",
    description: "Check browser availability. install=true explicitly downloads Playwright Chromium; never install it without user permission.",
    parameters: Type.Object({ install: Type.Optional(Type.Boolean()) }),
    execute: (_id, p, signal, _update, ctx) => doctor(!!p.install, signal, ctx),
  });
  pi.registerCommand("glitch-lab-doctor", {
    description: "Check browser availability; add install to download Chromium",
    handler: async (args, ctx) => {
      const r = await doctor(args.trim() === "install", undefined, ctx);
      ctx.ui.notify(r.content[0].text, r.isError ? "warning" : "info");
    },
  });
}
