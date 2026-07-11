import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { renderPdfToImages } from "@/lib/parsers/render";
import {
  readBatchFile, isPdfFile, isImageFile,
  cachePages, cachedPageCount, storedFileVersion,
} from "@/lib/uploads";
import { logger } from "@/lib/logger";

// Metadata for the source viewer: page count + a cache-busting version token.
// PDFs are rasterized ONCE into uploads/pages/<batchId>/ — subsequent opens hit
// that cache (and the browser's, via the immutable page-image URLs).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = logger.child({ route: "import-batches/pages" });
  const { id } = await params;
  const batchId = parseInt(id);

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (!batch.storedFile) {
    return NextResponse.json({ error: "No original file stored for this import" }, { status: 404 });
  }

  const version = await storedFileVersion(batch.storedFile);

  // Images are served directly as a single "page" — nothing to rasterize.
  if (isImageFile(batch.storedFile)) {
    return NextResponse.json({ filename: batch.filename, pageCount: 1, version });
  }

  if (!isPdfFile(batch.storedFile)) {
    return NextResponse.json({ error: "Stored file type has no visual pages (e.g. CSV)" }, { status: 422 });
  }

  let pageCount = await cachedPageCount(batchId);
  if (pageCount === 0) {
    // First open since the file was stored/replaced — render and cache.
    let buffer: Buffer;
    try {
      buffer = await readBatchFile(batch.storedFile);
    } catch {
      return NextResponse.json({ error: "Stored file is missing from disk" }, { status: 404 });
    }
    try {
      const t0 = Date.now();
      const r = await renderPdfToImages(buffer, { dpi: 150 }); // viewing resolution — half the payload of 200
      const pngs = r.images.map((dataUrl) => Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
      await cachePages(batchId, pngs);
      pageCount = pngs.length;
      log.info({ batchId, pageCount, ms: Date.now() - t0 }, "rendered and cached statement pages");
    } catch (err) {
      log.error({ err, batchId }, "failed to rasterize stored PDF");
      return NextResponse.json({ error: "PDF renderer unavailable" }, { status: 502 });
    }
  }

  return NextResponse.json({ filename: batch.filename, pageCount, version });
}
