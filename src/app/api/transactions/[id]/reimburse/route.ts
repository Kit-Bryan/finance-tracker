import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, isNull, gte, lte, desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transactions, categories, reimbursementAllocations } from "@/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "transactions/reimburse" });
const WINDOW_DAYS = 21;

interface CandidateRow {
  id: number;
  postedAt: Date;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryName: string | null;
  categoryColor: string | null;
}

// GET — everything the allocation editor needs for THIS repayment:
//  - the repayment's amount + how much is already allocated / left
//  - candidate expenses (±21d, amount < 0) plus any already-linked expense (even if
//    outside the window), each with its full cost, how much others repaid, and how
//    much THIS repayment currently applies to it.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const center = new Date(tx.postedAt);
  const from = new Date(center); from.setDate(from.getDate() - WINDOW_DAYS);
  const to = new Date(center); to.setDate(to.getDate() + WINDOW_DAYS);

  const windowRows = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      categoryName: categories.name,
      categoryColor: categories.color,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        ne(transactions.id, txId),
        isNull(transactions.deletedAt),
        gte(transactions.postedAt, from),
        lte(transactions.postedAt, to),
      )
    )
    .orderBy(desc(transactions.postedAt))
    .limit(100);

  // Only expenses (negative) can be reimbursed.
  const candidates: CandidateRow[] = windowRows.filter((r) => parseFloat(r.amount as string) < 0) as CandidateRow[];

  // Current allocations FROM this repayment (their expenses may sit outside the window).
  const myAllocs = await db
    .select({ expenseId: reimbursementAllocations.expenseId, amount: reimbursementAllocations.amount })
    .from(reimbursementAllocations)
    .where(eq(reimbursementAllocations.repaymentId, txId));
  const fromThis = new Map<number, number>();
  for (const a of myAllocs) fromThis.set(a.expenseId, (fromThis.get(a.expenseId) ?? 0) + parseFloat(a.amount));

  // Make sure already-linked expenses appear even if they're outside the ±21d window.
  const haveIds = new Set(candidates.map((c) => c.id));
  const missingLinkedIds = [...fromThis.keys()].filter((eid) => !haveIds.has(eid));
  if (missingLinkedIds.length) {
    const extra = await db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        description: transactions.description,
        merchantNormalized: transactions.merchantNormalized,
        amount: transactions.amount,
        categoryName: categories.name,
        categoryColor: categories.color,
      })
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inArray(transactions.id, missingLinkedIds), isNull(transactions.deletedAt)));
    candidates.push(...(extra as CandidateRow[]));
  }

  // How much each candidate has been repaid in total (across all repayments).
  const candidateIds = candidates.map((c) => c.id);
  const repaidTotalByExpense = new Map<number, number>();
  if (candidateIds.length) {
    const allAllocs = await db
      .select({ expenseId: reimbursementAllocations.expenseId, repaymentId: reimbursementAllocations.repaymentId, amount: reimbursementAllocations.amount })
      .from(reimbursementAllocations)
      .where(inArray(reimbursementAllocations.expenseId, candidateIds));
    for (const a of allAllocs) repaidTotalByExpense.set(a.expenseId, (repaidTotalByExpense.get(a.expenseId) ?? 0) + parseFloat(a.amount));
  }

  const allocatedTotal = [...fromThis.values()].reduce((s, v) => s + v, 0);
  const repaymentAmount = parseFloat(tx.amount as string);

  const out = candidates.map((c) => {
    const full = Math.abs(parseFloat(c.amount as string));
    const repaidTotal = repaidTotalByExpense.get(c.id) ?? 0;
    const currentFromThis = fromThis.get(c.id) ?? 0;
    const repaidByOthers = repaidTotal - currentFromThis;
    return {
      id: c.id,
      postedAt: c.postedAt,
      description: c.description,
      merchantNormalized: c.merchantNormalized,
      amount: c.amount,
      categoryName: c.categoryName,
      categoryColor: c.categoryColor,
      expenseFull: full,
      repaidByOthers,
      currentFromThis,
      // What's still uncovered if this repayment weren't applied.
      remainingNeed: Math.max(0, full - repaidByOthers),
    };
  });

  return NextResponse.json({
    repayment: { id: tx.id, amount: repaymentAmount, name: tx.merchantNormalized || tx.description },
    allocatedTotal,
    unallocated: repaymentAmount - allocatedTotal,
    candidates: out,
  });
}

// POST — save the allocation set for this repayment.
// Body: { allocations: [{ expenseId, amount }] }   (empty array clears all)
//   — or legacy: { expenseId: number | null }       (single full link / unlink)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json() as { allocations?: { expenseId: number; amount: number }[]; expenseId?: number | null };
  const repaymentAmount = parseFloat(tx.amount as string);

  // Normalise legacy single-link payload into the allocations array.
  let allocations: { expenseId: number; amount: number }[];
  if (Array.isArray(body.allocations)) {
    allocations = body.allocations;
  } else if (body.expenseId == null) {
    allocations = [];
  } else {
    allocations = [{ expenseId: body.expenseId, amount: Math.abs(repaymentAmount) }];
  }

  // Validate each allocation.
  for (const a of allocations) {
    if (a.expenseId === txId) return NextResponse.json({ error: "A transaction can't reimburse itself" }, { status: 400 });
    if (!(a.amount > 0)) return NextResponse.json({ error: "Each allocation amount must be greater than 0" }, { status: 400 });
  }
  const total = allocations.reduce((s, a) => s + a.amount, 0);
  if (total - Math.abs(repaymentAmount) > 0.01) {
    return NextResponse.json({ error: `Allocated ${total.toFixed(2)} exceeds the repayment of ${Math.abs(repaymentAmount).toFixed(2)}.` }, { status: 400 });
  }
  // Verify referenced expenses exist and are expenses.
  const ids = allocations.map((a) => a.expenseId);
  if (ids.length) {
    const found = await db.select({ id: transactions.id, amount: transactions.amount, deletedAt: transactions.deletedAt }).from(transactions).where(inArray(transactions.id, ids));
    const byId = new Map(found.map((f) => [f.id, f]));
    for (const a of allocations) {
      const e = byId.get(a.expenseId);
      if (!e || e.deletedAt) return NextResponse.json({ error: `Expense ${a.expenseId} not found` }, { status: 404 });
      if (parseFloat(e.amount as string) >= 0) return NextResponse.json({ error: `Transaction ${a.expenseId} isn't an expense` }, { status: 400 });
    }
  }

  // Replace this repayment's allocations atomically. Also clear the legacy single FK
  // so allocations are the single source of truth.
  await db.transaction(async (txn) => {
    await txn.delete(reimbursementAllocations).where(eq(reimbursementAllocations.repaymentId, txId));
    if (allocations.length) {
      await txn.insert(reimbursementAllocations).values(
        allocations.map((a) => ({ repaymentId: txId, expenseId: a.expenseId, amount: String(a.amount) }))
      );
    }
    await txn.update(transactions).set({ reimbursementForId: null, updatedAt: new Date() }).where(eq(transactions.id, txId));
  });

  log.info({ repaymentId: txId, count: allocations.length, total }, "reimbursement allocations saved");
  return NextResponse.json({ ok: true, count: allocations.length, allocatedTotal: total, unallocated: Math.abs(repaymentAmount) - total });
}
