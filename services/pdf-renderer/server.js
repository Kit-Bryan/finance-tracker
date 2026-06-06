// Minimal PDF → PNG rasterizer backed by poppler's `pdftoppm`.
// POST /render  (body: application/pdf)  → { pages, images: [base64png, ...] }
// GET  /health                           → { ok: true }
const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 5001;
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB upload cap

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Decode the handful of XML entities pdftotext emits in word text.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Parse `pdftotext -bbox` XHTML output into { pages: [{ width, height, words: [...] }] }.
// pdftotext bbox uses a top-left origin with y increasing downward (screen-like).
function parseBbox(xml) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let pm;
  while ((pm = pageRe.exec(xml)) !== null) {
    const width = parseFloat(pm[1]);
    const height = parseFloat(pm[2]);
    const inner = pm[3];
    const words = [];
    let wm;
    while ((wm = wordRe.exec(inner)) !== null) {
      words.push({
        xMin: parseFloat(wm[1]),
        yMin: parseFloat(wm[2]),
        xMax: parseFloat(wm[3]),
        yMax: parseFloat(wm[4]),
        text: decodeEntities(wm[5]).trim(),
      });
    }
    pages.push({ width, height, words });
  }
  return pages;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/health")) return send(res, 200, { ok: true });
  const isRender = req.url.startsWith("/render");
  const isTextbox = req.url.startsWith("/textbox");
  if (req.method !== "POST" || (!isRender && !isTextbox)) return send(res, 404, { error: "Not found" });

  const url = new URL(req.url, "http://localhost");
  const maxPages = Math.min(parseInt(url.searchParams.get("maxPages") || "50", 10) || 50, 50);
  const dpi = Math.min(parseInt(url.searchParams.get("dpi") || "200", 10) || 200, 400);

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) { send(res, 413, { error: "PDF too large" }); req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) return send(res, 400, { error: "Empty body" });

    const dir = path.join(os.tmpdir(), "render-" + crypto.randomBytes(8).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    const pdfPath = path.join(dir, "in.pdf");
    const outPrefix = path.join(dir, "page");

    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

    try {
      fs.writeFileSync(pdfPath, buf);

      // ── /textbox: extract per-word bounding boxes for programmatic row matching ──
      if (isTextbox) {
        // -bbox: emit one <word> per token with x/y bounds; "-" → stdout
        execFile("pdftotext", ["-bbox", "-l", String(maxPages), pdfPath, "-"], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) { cleanup(); return send(res, 500, { error: "pdftotext failed: " + (stderr || err.message) }); }
          try {
            send(res, 200, { pages: parseBbox(String(stdout)) });
          } catch (e) {
            send(res, 500, { error: String(e && e.message || e) });
          } finally {
            cleanup();
          }
        });
        return;
      }

      // ── /render: rasterize pages to PNG ─────────────────────────────────────────
      // Read the real page count first so we can tell the caller if we capped it.
      execFile("pdfinfo", [pdfPath], (infoErr, infoOut) => {
        let totalPages = null;
        if (!infoErr) {
          const m = String(infoOut).match(/Pages:\s+(\d+)/);
          if (m) totalPages = parseInt(m[1], 10);
        }
        // -png: PNG output, -r: DPI, -l: last page (cap)
        execFile("pdftoppm", ["-png", "-r", String(dpi), "-l", String(maxPages), pdfPath, outPrefix], (err, _stdout, stderr) => {
          if (err) { cleanup(); return send(res, 500, { error: "pdftoppm failed: " + (stderr || err.message) }); }
          try {
            const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
            const images = files.map((f) => fs.readFileSync(path.join(dir, f)).toString("base64"));
            const rendered = images.length;
            send(res, 200, {
              pages: rendered,
              totalPages,
              truncated: totalPages != null && totalPages > rendered,
              images,
            });
          } catch (e) {
            send(res, 500, { error: String(e && e.message || e) });
          } finally {
            cleanup();
          }
        });
      });
    } catch (e) {
      cleanup();
      send(res, 500, { error: String(e && e.message || e) });
    }
  });
});

server.listen(PORT, () => console.log("pdf-renderer listening on " + PORT));
