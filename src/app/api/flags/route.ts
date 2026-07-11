import { NextResponse } from "next/server";
import { db } from "@/db";
import { flags, transactions, categories, accounts, importBatches, reimbursementAllocations } from "@/db/schema";
import { eq, inArray, desc, sql } from "drizzle-orm";
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
      // Allocation-table links (current mechanism; reimbursementForId is legacy)
      isAllocatedRepayment: sql<boolean>`exists (select 1 from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id})`,
      hasIncomingAllocations: sql<boolean>`exists (select 1 from ${reimbursementAllocations} a where a.expense_id = ${transactions.id})`,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      categoryName: categories.name,
      categoryColor: categories.color,
      accountName: accounts.name,
      // Source trace-back: lets the dashboard cards open the original statement
      batchId: transactions.batchId,
      batchStoredFile: importBatches.storedFile,
      sourcePage: sql<number | null>`(${transactions.rawRow}->>'page')::int`,
      sourceYPercent: sql<number | null>`(${transactions.rawRow}->>'yPercent')::float`,
    })
    .from(flags)
    .innerJoin(transactions, eq(flags.transactionId, transactions.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(importBatches, eq(transactions.batchId, importBatches.id))
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
      // An allocated repayment doesn't need a category — insights nets it
      // against its expenses. Without this, its low-confidence flag nags forever.
      else if (f.isAllocatedRepayment) stale = true;
    } else if (f.type === "reimbursement") {
      if (f.txReimbursementForId != null) stale = true;          // legacy single link
      else if (f.isAllocatedRepayment || f.hasIncomingAllocations) stale = true; // allocation-table links (either side)
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
      batchId: f.batchId,
      batchStoredFile: f.batchStoredFile,
      sourcePage: f.sourcePage,
      sourceYPercent: f.sourceYPercent,
    }))
  );
}
