import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts, importBatches, reimbursementAllocations } from "@/db/schema";
import { eq, and, isNull, lt, or, sql } from "drizzle-orm";
import { CONFIDENCE_THRESHOLD } from "@/lib/ai/constants";

export async function GET() {
  // Flagged = uncategorized OR agent-categorized below threshold
  const flagged = await db
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
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
      accountName: accounts.name,
      // Source trace-back: lets the review UI open the original statement
      batchId: transactions.batchId,
      batchStoredFile: importBatches.storedFile,
      sourcePage: sql<number | null>`(${transactions.rawRow}->>'page')::int`,
      sourceYPercent: sql<number | null>`(${transactions.rawRow}->>'yPercent')::float`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(importBatches, eq(transactions.batchId, importBatches.id))
    .where(
      and(
        isNull(transactions.deletedAt),
        isNull(transactions.reimbursementForId), // legacy single-link repayments don't need categorizing
        // Allocated repayments (reimbursement_allocations is the current source of
        // truth) don't need categorizing either — insights nets them against their
        // expenses. Without this they reappear in the queue after every refresh.
        sql`not exists (select 1 from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id})`,
        or(
          isNull(transactions.categoryId),
          and(
            eq(transactions.categorySource, "agent"),
            lt(transactions.categoryConfidence, String(CONFIDENCE_THRESHOLD))
          )
        )
      )
    )
    .orderBy(transactions.postedAt)
    .limit(100);

  return NextResponse.json(flagged);
}
