import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";

// Original statement files are kept under uploads/ (git-ignored) so transactions
// can be traced back to the exact spot in the source document.
const UPLOADS_DIR = path.join(process.cwd(), "uploads");

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

/** Delete a stored batch file. Missing files are ignored. */
export async function deleteBatchFile(storedFile: string | null | undefined): Promise<void> {
  if (!storedFile) return;
  try {
    await unlink(path.resolve(UPLOADS_DIR, path.basename(storedFile)));
  } catch {
    // already gone — fine
  }
}
