import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { eq, and, isNull, lt, or, not } from "drizzle-orm";
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
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        isNull(transactions.deletedAt),
        isNull(transactions.reimbursementForId), // linked repayments don't need categorizing
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
