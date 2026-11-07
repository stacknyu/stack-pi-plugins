// Tiny static server for the example app (SPA fallback to index.html). Usage: node serve.mjs [port]
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.argv[2] || 4321);
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
http.createServer((req, res) => {
  let p;
  try { p = path.resolve(root, "." + decodeURIComponent(new URL(req.url, "http://x").pathname)); }
  catch { res.writeHead(400); res.end("Invalid URL"); return; }
  if (!p.startsWith(root + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Glitchy example app: http://localhost:${port}/dashboard`));
