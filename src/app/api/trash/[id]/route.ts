import { NextRequest, NextResponse } from "next/server";
import { eq, isNotNull, and } from "drizzle-orm";
import { db } from "@/db";
import { transactions, importBatches } from "@/db/schema";

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

  return NextResponse.json({ ok: true });
}
