import { NextRequest, NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { transactions, categories, accounts, reimbursementAllocations } from "@/db/schema";
import { learnMerchant, pruneOrphanMerchants } from "@/lib/categorizer/rules";

const parentCat = alias(categories, "parent_cat");
const linkedTx = alias(transactions, "linked_tx");

// Returns one transaction with allocation rollups + both-direction allocation lists,
// so the detail panel can render the full repayment picture (and load a linked
// expense that falls outside the current filter range).
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
      allocatedIn: sql<string>`(select coalesce(sum(a.amount), 0) from ${reimbursementAllocations} a where a.expense_id = ${transactions.id})`,
      allocatedOut: sql<string>`(select coalesce(sum(a.amount), 0) from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id})`,
      notes: transactions.notes,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(parentCat, eq(categories.parentId, parentCat.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.id, id));

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // allocationsOut: expenses THIS row (as a repayment) covers.
  const allocationsOut = await db
    .select({
      allocationId: reimbursementAllocations.id,
      expenseId: reimbursementAllocations.expenseId,
      amount: reimbursementAllocations.amount,
      name: sql<string | null>`coalesce(${linkedTx.merchantNormalized}, ${linkedTx.description})`,
      postedAt: linkedTx.postedAt,
      txAmount: linkedTx.amount,
    })
    .from(reimbursementAllocations)
    .innerJoin(linkedTx, eq(reimbursementAllocations.expenseId, linkedTx.id))
    .where(eq(reimbursementAllocations.repaymentId, id));

  // allocationsIn: repayments applied TO this row (as an expense).
  const allocationsIn = await db
    .select({
      allocationId: reimbursementAllocations.id,
      repaymentId: reimbursementAllocations.repaymentId,
      amount: reimbursementAllocations.amount,
      name: sql<string | null>`coalesce(${linkedTx.merchantNormalized}, ${linkedTx.description})`,
      postedAt: linkedTx.postedAt,
      txAmount: linkedTx.amount,
    })
    .from(reimbursementAllocations)
    .innerJoin(linkedTx, eq(reimbursementAllocations.repaymentId, linkedTx.id))
    .where(and(eq(reimbursementAllocations.expenseId, id)));

  return NextResponse.json({ ...row, allocationsIn, allocationsOut });
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
