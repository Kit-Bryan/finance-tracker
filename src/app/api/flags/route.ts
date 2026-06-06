import { NextResponse } from "next/server";
import { db } from "@/db";
import { flags, transactions, categories, accounts } from "@/db/schema";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { CONFIDENCE_THRESHOLD } from "@/lib/ai/constants";

// GET /api/flags — open flags joined with their transaction.
// Auto-resolves stale flags (already-categorized, already-linked, deleted) so the feed stays accurate.
export async function GET() {
  const open = await db
    .select({
      id: flags.id,
      transactionId: flags.transactionId,
      type: flags.type,
      severity: flags.severity,
      reason: flags.reason,
      data: flags.data,
      createdAt: flags.createdAt,
      txDeletedAt: transactions.deletedAt,
      txCategoryId: transactions.categoryId,
      txCategorySource: transactions.categorySource,
      txCategoryConfidence: transactions.categoryConfidence,
      txReimbursementForId: transactions.reimbursementForId,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      categoryName: categories.name,
      categoryColor: categories.color,
      accountName: accounts.name,
    })
    .from(flags)
    .innerJoin(transactions, eq(flags.transactionId, transactions.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(flags.status, "open"))
    .orderBy(desc(flags.createdAt));

  const staleIds: number[] = [];
  const live: typeof open = [];

  for (const f of open) {
    let stale = false;
    if (f.txDeletedAt) stale = true;
    else if (f.type === "low_confidence") {
      // Resolved once the tx is user-categorized or confidently auto-categorized
      if (f.txCategoryId != null && f.txCategorySource === "user") stale = true;
      else if (
        f.txCategoryId != null &&
        f.txCategorySource === "agent" &&
        f.txCategoryConfidence != null &&
        parseFloat(f.txCategoryConfidence as string) >= CONFIDENCE_THRESHOLD
      ) stale = true;
    } else if (f.type === "reimbursement") {
      if (f.txReimbursementForId != null) stale = true; // expense itself was linked elsewhere
    }
    if (stale) staleIds.push(f.id);
    else live.push(f);
  }

  if (staleIds.length > 0) {
    await db
      .update(flags)
      .set({ status: "resolved", updatedAt: new Date() })
      .where(inArray(flags.id, staleIds));
  }

  return NextResponse.json(
    live.map((f) => ({
      id: f.id,
      transactionId: f.transactionId,
      type: f.type,
      severity: f.severity,
      reason: f.reason,
      data: f.data,
      createdAt: f.createdAt,
      postedAt: f.postedAt,
      description: f.description,
      merchantNormalized: f.merchantNormalized,
      amount: f.amount,
      categoryId: f.txCategoryId,
      categoryName: f.categoryName,
      categoryColor: f.categoryColor,
      accountName: f.accountName,
    }))
  );
}
