import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, isNull, gte, lte, desc } from "drizzle-orm";
import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "transactions/reimburse" });
const WINDOW_DAYS = 21;

// GET — candidate expenses this repayment could offset: nearby (±21d), an actual
// expense (amount < 0), not deleted, not itself a reimbursement.
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

  const rows = await db
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
        isNull(transactions.reimbursementForId),
        gte(transactions.postedAt, from),
        lte(transactions.postedAt, to),
      )
    )
    .orderBy(desc(transactions.postedAt))
    .limit(100);

  // Only expenses (negative) can be reimbursed
  const candidates = rows.filter((r) => parseFloat(r.amount as string) < 0);
  return NextResponse.json(candidates);
}

// POST { expenseId: number | null } — link this repayment to an expense, or unlink (null).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);
  const { expenseId } = await req.json() as { expenseId: number | null };

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId));
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (expenseId == null) {
    await db.update(transactions).set({ reimbursementForId: null, updatedAt: new Date() }).where(eq(transactions.id, txId));
    log.info({ repaymentId: txId }, "reimbursement link removed");
    return NextResponse.json({ ok: true, linked: false });
  }

  if (expenseId === txId) {
    return NextResponse.json({ error: "A transaction can't reimburse itself" }, { status: 400 });
  }
  const [expense] = await db.select().from(transactions).where(eq(transactions.id, expenseId));
  if (!expense || expense.deletedAt) {
    return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  }

  await db.update(transactions).set({ reimbursementForId: expenseId, updatedAt: new Date() }).where(eq(transactions.id, txId));
  log.info({ repaymentId: txId, expenseId }, "reimbursement linked");
  return NextResponse.json({ ok: true, linked: true });
}
