#!/usr/bin/env node
// doctor.mjs — can Glitch Lab start a browser here?
import { loadPlaywright, launchBrowser, parseArgs } from "./lib.mjs";
const args = parseArgs();
const { chromium } = await loadPlaywright();
try {
  const b = await launchBrowser(chromium, args);
  const p = await b.newPage(); await p.setContent("<p>ok</p>");
  console.log(`browser: OK (${b.browserType().name()} ${b.version()})`);
  await b.close();
} catch (e) {
  console.log(`browser: FAILED — ${e.message}`);
  process.exit(1);
}
