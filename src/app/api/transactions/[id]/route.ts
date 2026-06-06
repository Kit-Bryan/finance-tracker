import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { learnMerchant, pruneOrphanMerchants } from "@/lib/categorizer/rules";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  const body = await req.json();
  const { categoryId, notes, description, amount, postedAt, hidden } = body;

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .update(transactions)
    .set({
      ...(categoryId !== undefined ? { categoryId, categorySource: "user", categoryConfidence: "1" } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(amount !== undefined ? { amount: String(parseFloat(amount)) } : {}),
      ...(postedAt !== undefined ? { postedAt: new Date(postedAt) } : {}),
      ...(hidden !== undefined ? { hidden: !!hidden } : {}),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id));

  if (categoryId !== undefined && tx.description) {
    await learnMerchant(tx.description, categoryId, "user");
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Soft delete — keep the row, set deleted_at
  await db
    .update(transactions)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, id));

  // Forget merchant memory if no live transaction still backs it
  await pruneOrphanMerchants([tx.description]);

  return NextResponse.json({ ok: true });
}
