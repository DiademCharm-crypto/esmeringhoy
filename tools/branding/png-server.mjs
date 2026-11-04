/* ============================================================================
   ESMERINGHOY — PNG EXPORT SINK
   ----------------------------------------------------------------------------
   This machine has no SVG rasteriser (no sharp, no ImageMagick, no cairosvg),
   and the browser next door renders vectors perfectly. So: the rasterising page
   draws each SVG on a canvas at the target size and POSTs the PNG bytes here,
   and this writes them next to the vectors.

   It only serves this repo read-only and only accepts a whitelisted filename, so
   it cannot be used to write anywhere else.

     node tools/branding/png-server.mjs [port]

   Then open http://127.0.0.1:8791/rasterize.html and leave it to run.
   ========================================================================== */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] || 8791);
const ROOT = process.cwd();
const OUT = path.join(ROOT, "assets", "branding");

/* Exactly the files the browser page is allowed to write. */
const ALLOWED = new Set([
  "esmeringhoy-logo-horizontal-512.png",
  "esmeringhoy-logo-horizontal-1024.png",
  "esmeringhoy-icon-512.png",
  "esmeringhoy-icon-1024.png"
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8"
};

function serve(res, file) {
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end("no");
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(full)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/save") {
      const name = url.searchParams.get("name") || "";
      if (!ALLOWED.has(name)) {
        res.writeHead(400).end("name not allowed");
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(path.join(OUT, name), buf);
        console.log("wrote " + name + " (" + buf.length + " bytes)");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, bytes: buf.length }));
      });
      return;
    }

    /* the driver page lives beside this script, but its image paths and the
       sink's output are both relative to the repo root */
    if (url.pathname === "/rasterize.html") {
      serve(res, path.join("tools", "branding", "rasterize.html"));
      return;
    }

    serve(res, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("png sink on http://127.0.0.1:" + PORT + "/rasterize.html");
  });
