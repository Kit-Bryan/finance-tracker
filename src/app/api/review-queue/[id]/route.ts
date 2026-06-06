import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { learnMerchant } from "@/lib/categorizer/rules";

// Resolve a flagged transaction — user confirms or overrides the category
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);
  const { categoryId, skip, note } = await req.json();

  if (skip) {
    // User doesn't know — mark confidence as 1 with no category change so it leaves the queue
    await db
      .update(transactions)
      .set({ categoryConfidence: "1", categorySource: "user", updatedAt: new Date() })
      .where(eq(transactions.id, txId));
    return NextResponse.json({ ok: true });
  }

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .update(transactions)
    .set({
      categoryId,
      categorySource: "user",
      categoryConfidence: "1",
      ...(note ? { notes: note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, txId));

  // Teach the merchant memory
  if (tx.description) await learnMerchant(tx.description, categoryId, "user");

  return NextResponse.json({ ok: true });
}
