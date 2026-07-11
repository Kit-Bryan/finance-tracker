import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { readBatchFile, readCachedPage, isImageFile, mimeFor } from "@/lib/uploads";

// One rendered statement page as a real image. URLs carry a ?v= mtime token, so
// aggressive browser caching is safe — replacing the file changes the URL.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; pageIndex: string }> }
) {
  const { id, pageIndex } = await params;
  const batchId = parseInt(id);
  const idx = parseInt(pageIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: "Bad page index" }, { status: 400 });
  }

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch?.storedFile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const headers = {
    "Cache-Control": "private, max-age=31536000, immutable",
  };

  // Image statements: the original file IS page 0.
  if (isImageFile(batch.storedFile)) {
    if (idx !== 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      const buf = await readBatchFile(batch.storedFile);
      return new NextResponse(new Uint8Array(buf), { headers: { ...headers, "Content-Type": mimeFor(batch.storedFile) } });
    } catch {
      return NextResponse.json({ error: "Stored file is missing from disk" }, { status: 404 });
    }
  }

  // PDFs: serve from the rendered-page cache (populated by the /pages metadata route).
  try {
    const buf = await readCachedPage(batchId, idx);
    return new NextResponse(new Uint8Array(buf), { headers: { ...headers, "Content-Type": "image/png" } });
  } catch {
    return NextResponse.json({ error: "Page not cached — load the viewer metadata first" }, { status: 404 });
  }
}
