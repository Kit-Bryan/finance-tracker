import { NextRequest, NextResponse } from "next/server";
import { eq, isNotNull, and } from "drizzle-orm";
import { db } from "@/db";
import { transactions, importBatches } from "@/db/schema";
import { learnMerchant } from "@/lib/categorizer/rules";
import { permanentlyDeleteTransactions } from "@/lib/trash";

// Restore a single soft-deleted transaction
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), isNotNull(transactions.deletedAt)));

  if (!tx) return NextResponse.json({ error: "Not found in trash" }, { status: 404 });

  await db
    .update(transactions)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(transactions.id, txId));

  // Re-learn merchant memory for the restored transaction (it's live again)
  if (tx.categoryId != null) {
    await learnMerchant(tx.description, tx.categoryId);
  }

  return NextResponse.json({ ok: true });
}

// Permanently delete a single soft-deleted transaction
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [tx] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, txId), isNotNull(transactions.deletedAt)));

  if (!tx) return NextResponse.json({ error: "Not found in trash" }, { status: 404 });

  const deleted = await permanentlyDeleteTransactions([txId]);
  return NextResponse.json({ ok: true, deleted });
}
