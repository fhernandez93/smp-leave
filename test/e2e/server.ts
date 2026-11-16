/**
 * Serves the published page the way claude.ai does: dist/artifact.html wrapped
 * in a doctype/head/body skeleton with the platform's small reset.
 *   /     → v2 (the file we publish)
 *   /v1   → the original v1 page, used as a parity oracle
 * Run: node test/e2e/server.ts  (port 4173)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const RESET = "html{color-scheme:light}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}";
const wrap = (page: string) =>
  `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${RESET}</style></head><body>${page}</body></html>`;

const port = Number(process.env.PORT || 4173);
createServer((req, res) => {
  try {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(wrap(readFileSync("dist/artifact.html", "utf8")));
    } else if (req.url === "/v1") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync("test/fixtures/v1.html", "utf8"));
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, () => console.log(`e2e server on http://localhost:${port}`));
