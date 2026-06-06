import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, transactions, transactionsStaging } from "@/db/schema";
import { pruneOrphanMerchants } from "@/lib/categorizer/rules";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = parseInt(id);

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const now = new Date();

  // Soft-delete all transactions in this batch
  const softDeleted = await db
    .update(transactions)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(transactions.batchId, batchId))
    .returning({ id: transactions.id, description: transactions.description });

  // Soft-delete the batch itself
  await db
    .update(importBatches)
    .set({ deletedAt: now })
    .where(eq(importBatches.id, batchId));

  // Forget merchant memory for any merchants no live transaction still backs
  await pruneOrphanMerchants(softDeleted.map((t) => t.description));

  return NextResponse.json({ deleted: softDeleted.length });
}
