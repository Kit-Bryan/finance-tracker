import { db } from "@/db";
import { transactions, flags } from "@/db/schema";
import { and, eq, gte, isNull, desc, inArray } from "drizzle-orm";
import { CONFIDENCE_THRESHOLD } from "@/lib/ai/constants";

// A merchant string looks like an incoming person-to-person transfer
function looksLikeTransferIn(description: string, merchant: string | null): boolean {
  const desc = ((description ?? "") + " " + (merchant ?? "")).toLowerCase();
  return (
    desc.includes("fund tr") || desc.includes("duitnow") || desc.includes("ibk") ||
    desc.includes(" trf ") || desc.includes("transfer") || desc.includes("fpx") ||
    desc.includes("a/c") || desc.includes("interbank") || desc.includes("pymt from") ||
    desc.includes("payment from") || desc.includes("received from")
  );
}

/**
 * Return transaction IDs that already have an open OR dismissed flag of a given type.
 * Used to make detection idempotent and to never re-nag about a dismissed item.
 */
async function alreadyFlagged(txIds: number[], type: string): Promise<Set<number>> {
  if (txIds.length === 0) return new Set();
  const rows = await db
    .select({ transactionId: flags.transactionId })
    .from(flags)
    .where(
      and(
        inArray(flags.transactionId, txIds),
        eq(flags.type, type),
        inArray(flags.status, ["open", "dismissed"])
      )
    );
  return new Set(rows.map((r) => r.transactionId));
}

/**
 * Detect group-expense reimbursement patterns: a large outgoing expense followed
 * within 7 days by incoming person-to-person transfers that sum to ≥30% of it.
 * Creates one "reimbursement" flag on the expense, carrying candidate IDs.
 */
export async function detectReimbursements(lookbackDays = 30): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);

  const allTx = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      reimbursementForId: transactions.reimbursementForId,
    })
    .from(transactions)
    .where(and(gte(transactions.postedAt, since), isNull(transactions.deletedAt), isNull(transactions.reimbursementForId)))
    .orderBy(desc(transactions.postedAt));

  const expenses = allTx.filter((t) => parseFloat(t.amount as string) < -30);
  const incoming = allTx.filter(
    (t) => parseFloat(t.amount as string) > 0 && looksLikeTransferIn(t.description, t.merchantNormalized)
  );

  const skip = await alreadyFlagged(expenses.map((e) => e.id), "reimbursement");

  let created = 0;
  for (const expense of expenses) {
    if (skip.has(expense.id)) continue;

    const expDate = new Date(expense.postedAt);
    const windowEnd = new Date(expDate);
    windowEnd.setDate(windowEnd.getDate() + 7);

    const candidates = incoming.filter((t) => {
      const d = new Date(t.postedAt);
      return d >= expDate && d <= windowEnd;
    });
    if (candidates.length === 0) continue;

    const totalReimbursed = candidates.reduce((s, t) => s + parseFloat(t.amount as string), 0);
    const expenseAbs = Math.abs(parseFloat(expense.amount as string));
    if (totalReimbursed < expenseAbs * 0.3) continue;

    const yourShare = parseFloat(expense.amount as string) + totalReimbursed;
    const name = expense.merchantNormalized || expense.description;

    await db.insert(flags).values({
      transactionId: expense.id,
      type: "reimbursement",
      severity: "info",
      reason: `${candidates.length} incoming transfer${candidates.length !== 1 ? "s" : ""} totalling MYR ${totalReimbursed.toFixed(2)} look like repayments for "${name}". Your share would be MYR ${Math.abs(yourShare).toFixed(2)}.`,
      data: {
        reimbursementIds: candidates.map((c) => c.id),
        totalReimbursed,
        yourShare,
        expenseAmount: parseFloat(expense.amount as string),
        candidates: candidates.map((c) => ({
          id: c.id,
          description: c.merchantNormalized || c.description,
          amount: parseFloat(c.amount as string),
          date: new Date(c.postedAt).toISOString().slice(0, 10),
        })),
      },
    });
    created++;
  }
  return created;
}

/**
 * Detect transactions that need a human eye on their category:
 * uncategorized, or AI-categorized below the confidence threshold.
 * Creates one "low_confidence" flag per transaction.
 */
export async function detectLowConfidence(): Promise<number> {
  const rows = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
    })
    .from(transactions)
    .where(isNull(transactions.deletedAt));

  const needsReview = rows.filter((r) => {
    if (r.categoryId == null) return true;
    if (r.categorySource === "agent") {
      const conf = r.categoryConfidence ? parseFloat(r.categoryConfidence as string) : 0;
      return conf < CONFIDENCE_THRESHOLD;
    }
    return false;
  });

  const skip = await alreadyFlagged(needsReview.map((r) => r.id), "low_confidence");

  let created = 0;
  for (const tx of needsReview) {
    if (skip.has(tx.id)) continue;
    const name = tx.merchantNormalized || tx.description;
    const conf = tx.categoryConfidence ? parseFloat(tx.categoryConfidence as string) : null;
    await db.insert(flags).values({
      transactionId: tx.id,
      type: "low_confidence",
      severity: "warning",
      reason: tx.categoryId == null
        ? `"${name}" is uncategorized.`
        : `"${name}" was auto-categorized with low confidence (${conf !== null ? Math.round(conf * 100) : "?"}%).`,
      data: null,
    });
    created++;
  }
  return created;
}

export async function runAllDetectors(): Promise<{ reimbursement: number; lowConfidence: number }> {
  const reimbursement = await detectReimbursements();
  const lowConfidence = await detectLowConfidence();
  return { reimbursement, lowConfidence };
}
