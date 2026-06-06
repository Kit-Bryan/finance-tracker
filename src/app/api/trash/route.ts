import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts, importBatches } from "@/db/schema";
import { eq, desc, isNotNull, and } from "drizzle-orm";
import { permanentlyDeleteTransactions } from "@/lib/trash";

export async function GET() {
  // Deleted transactions, grouped with their batch info
  const deleted = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      currency: transactions.currency,
      categoryName: categories.name,
      categoryColor: categories.color,
      accountName: accounts.name,
      deletedAt: transactions.deletedAt,
      batchId: transactions.batchId,
      batchFilename: importBatches.filename,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(importBatches, eq(transactions.batchId, importBatches.id))
    .where(isNotNull(transactions.deletedAt))
    .orderBy(desc(transactions.deletedAt))
    .limit(500);

  return NextResponse.json(deleted);
}

// Empty the trash — permanently delete all soft-deleted transactions
export async function DELETE() {
  const ids = (
    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(isNotNull(transactions.deletedAt))
  ).map((r) => r.id);

  const deleted = await permanentlyDeleteTransactions(ids);
  return NextResponse.json({ ok: true, deleted });
}
