import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, transactions } from "@/db/schema";
import { extractPdfTextBoxes } from "@/lib/parsers/render";
import { matchTransactionsToLines } from "@/lib/parsers/locate";
import { mapTransactionsToLines } from "@/lib/ai/parse";
import { saveBatchFile, deleteBatchFile, isPdfFile } from "@/lib/uploads";
import { logger } from "@/lib/logger";

// Attach (or replace) the original statement file on an EXISTING batch, then
// re-derive each transaction's position in the document so trace-back works
// for imports that predate file storage.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = logger.child({ route: "import-batches/sync-file" });
  const { id } = await params;
  const batchId = parseInt(id);

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());

  // Replace any previously stored file
  await deleteBatchFile(batch.storedFile);
  const stored = await saveBatchFile(batchId, file.name, buffer);
  await db.update(importBatches).set({ storedFile: stored }).where(eq(importBatches.id, batchId));

  // Re-derive positions — only possible for PDFs with a text layer. Images and
  // scanned PDFs still get the file stored (viewable), just without highlights.
  let located = 0;
  const liveTx = await db
    .select({ id: transactions.id, amount: transactions.amount, rawRow: transactions.rawRow })
    .from(transactions)
    .where(and(eq(transactions.batchId, batchId), isNull(transactions.deletedAt)))
    .orderBy(asc(transactions.id)); // insertion order = statement order

  if (isPdfFile(stored) && liveTx.length > 0) {
    try {
      const bboxPages = await extractPdfTextBoxes(buffer);
      if (bboxPages.length > 0) {
        const txInputs = liveTx.map((t) => {
          const raw = (t.rawRow ?? {}) as { date?: string };
          return { amount: parseFloat(t.amount as string), date: raw.date ?? "" };
        });
        const { positions, unmatchedIndexes, lines } = matchTransactionsToLines(txInputs, bboxPages);

        const posByIndex = new Map(positions.map((p) => [p.index, p]));

        // LLM fallback for the stragglers the amount/date matcher missed
        if (unmatchedIndexes.length > 0 && lines.length > 0) {
          const stragglers = unmatchedIndexes.map((i) => {
            const raw = (liveTx[i].rawRow ?? {}) as { date?: string; description?: string };
            return { index: i, date: raw.date ?? "", description: raw.description ?? "", amount: parseFloat(liveTx[i].amount as string) };
          });
          const mapped = await mapTransactionsToLines(lines, stragglers);
          for (const m of mapped) {
            const line = lines[m.lineIndex];
            if (line && !posByIndex.has(m.index)) {
              posByIndex.set(m.index, { index: m.index, page: line.page, yPercent: line.yPercent });
            }
          }
        }

        for (const [i, p] of posByIndex) {
          const tx = liveTx[i];
          if (!tx) continue;
          // Merge position into the existing rawRow JSONB without clobbering it
          await db
            .update(transactions)
            .set({
              rawRow: sql`coalesce(${transactions.rawRow}, '{}'::jsonb) || ${JSON.stringify({ page: p.page, yPercent: p.yPercent })}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(transactions.id, tx.id));
          located++;
        }
      }
    } catch (err) {
      log.warn({ err, batchId }, "position re-derivation failed — file stored without highlights");
    }
  }

  log.info({ batchId, stored, transactions: liveTx.length, located }, "synced original file to batch");
  return NextResponse.json({ ok: true, storedFile: stored, transactions: liveTx.length, located });
}
