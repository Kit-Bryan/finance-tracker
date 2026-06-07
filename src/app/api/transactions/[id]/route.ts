import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { learnMerchant, pruneOrphanMerchants } from "@/lib/categorizer/rules";

const parentCat = alias(categories, "parent_cat");
const reimbExpense = alias(transactions, "reimb_expense");

// Returns one transaction in the same enriched shape as the list endpoint, so the
// detail panel can load a linked expense that falls outside the current filter range.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const [row] = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      currency: transactions.currency,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      parentCategoryName: parentCat.name,
      accountId: transactions.accountId,
      accountName: accounts.name,
      isTransfer: transactions.isTransfer,
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
      hidden: transactions.hidden,
      reimbursementForId: transactions.reimbursementForId,
      reimbursementForName: sql<string | null>`coalesce(${reimbExpense.merchantNormalized}, ${reimbExpense.description})`,
      reimbursementForAmount: reimbExpense.amount,
      reimbursementForPostedAt: reimbExpense.postedAt,
      reimbursedTotal: sql<string | null>`(
        select sum(r.amount) from ${transactions} r
        where r.reimbursement_for_id = ${transactions.id} and r.deleted_at is null
      )`,
      notes: transactions.notes,
    })
    .from(transactions)
    .leftJoin(reimbExpense, eq(transactions.reimbursementForId, reimbExpense.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(parentCat, eq(categories.parentId, parentCat.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.id, id));

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

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
