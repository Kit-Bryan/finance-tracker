import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { renderPdfToImages } from "@/lib/parsers/render";
import { readBatchFile, isPdfFile, isImageFile, mimeFor } from "@/lib/uploads";
import { logger } from "@/lib/logger";

// Rasterized pages of a batch's stored original statement, for the source
// trace-back viewer. PDFs render via poppler; images are returned as one page.
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

  let buffer: Buffer;
  try {
    buffer = await readBatchFile(batch.storedFile);
  } catch {
    return NextResponse.json({ error: "Stored file is missing from disk" }, { status: 404 });
  }

  if (isPdfFile(batch.storedFile)) {
    try {
      const r = await renderPdfToImages(buffer);
      return NextResponse.json({ filename: batch.filename, pages: r.images, truncated: r.truncated });
    } catch (err) {
      log.error({ err, batchId }, "failed to rasterize stored PDF");
      return NextResponse.json({ error: "PDF renderer unavailable" }, { status: 502 });
    }
  }

  if (isImageFile(batch.storedFile)) {
    const dataUrl = `data:${mimeFor(batch.storedFile)};base64,${buffer.toString("base64")}`;
    return NextResponse.json({ filename: batch.filename, pages: [dataUrl] });
  }

  return NextResponse.json({ error: "Stored file type has no visual pages (e.g. CSV)" }, { status: 422 });
}
