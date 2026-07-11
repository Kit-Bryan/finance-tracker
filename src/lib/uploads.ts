import { mkdir, writeFile, readFile, unlink, rm, readdir, stat } from "fs/promises";
import path from "path";

// Original statement files are kept under uploads/ (git-ignored) so transactions
// can be traced back to the exact spot in the source document.
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
// Rendered page PNGs are cached per batch so the source viewer doesn't
// re-rasterize the PDF on every open.
const PAGES_DIR = path.join(UPLOADS_DIR, "pages");

function safeExt(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return /^(pdf|png|jpe?g|webp|gif|bmp|csv)$/.test(ext) ? ext : "bin";
}

export function isPdfFile(storedFile: string): boolean {
  return storedFile.toLowerCase().endsWith(".pdf");
}

export function isImageFile(storedFile: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(storedFile);
}

export function mimeFor(storedFile: string): string {
  const ext = storedFile.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "csv": return "text/csv";
    default: return "application/octet-stream";
  }
}

/** Persist a batch's original file. Returns the relative stored name (e.g. "batch-12.pdf"). */
export async function saveBatchFile(batchId: number, originalName: string, buffer: Buffer): Promise<string> {
  await mkdir(UPLOADS_DIR, { recursive: true });
  const stored = `batch-${batchId}.${safeExt(originalName)}`;
  await writeFile(path.join(UPLOADS_DIR, stored), buffer);
  return stored;
}

/** Read a stored batch file. Throws if missing. */
export async function readBatchFile(storedFile: string): Promise<Buffer> {
  // Resolve within uploads/ only — storedFile comes from the DB, but stay defensive.
  const resolved = path.resolve(UPLOADS_DIR, path.basename(storedFile));
  return readFile(resolved);
}

/** Delete a stored batch file AND its cached rendered pages. Missing files are ignored. */
export async function deleteBatchFile(storedFile: string | null | undefined): Promise<void> {
  if (!storedFile) return;
  try {
    await unlink(path.resolve(UPLOADS_DIR, path.basename(storedFile)));
  } catch {
    // already gone — fine
  }
  const m = /^batch-(\d+)\./.exec(path.basename(storedFile));
  if (m) await clearCachedPages(parseInt(m[1]));
}

// ── Rendered-page cache ───────────────────────────────────────────────────────

function pagesDirFor(batchId: number): string {
  return path.join(PAGES_DIR, String(batchId));
}

/** Write rendered page PNGs for a batch. Replaces any existing cache. */
export async function cachePages(batchId: number, pngs: Buffer[]): Promise<void> {
  const dir = pagesDirFor(batchId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(pngs.map((buf, i) => writeFile(path.join(dir, `${i}.png`), buf)));
}

/** How many pages are cached for a batch. 0 = not cached. */
export async function cachedPageCount(batchId: number): Promise<number> {
  try {
    const files = await readdir(pagesDirFor(batchId));
    return files.filter((f) => /^\d+\.png$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** Read one cached page PNG. Throws if missing. */
export async function readCachedPage(batchId: number, pageIndex: number): Promise<Buffer> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("bad page index");
  return readFile(path.join(pagesDirFor(batchId), `${pageIndex}.png`));
}

/** Drop a batch's cached pages (e.g. when its file is replaced or deleted). */
export async function clearCachedPages(batchId: number): Promise<void> {
  await rm(pagesDirFor(batchId), { recursive: true, force: true });
}

/** mtime of the stored file (ms) — used as a cache-busting token in page URLs. */
export async function storedFileVersion(storedFile: string): Promise<number> {
  try {
    const s = await stat(path.resolve(UPLOADS_DIR, path.basename(storedFile)));
    return Math.round(s.mtimeMs);
  } catch {
    return 0;
  }
}
