import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, reimbursementAllocations } from "@/db/schema";
import { sql, eq, and, gte, lte, isNull, inArray, or } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const to = searchParams.get("to") ?? new Date().toISOString();

  const fromDate = new Date(from);
  const toDate = new Date(to);
  // `to` arrives as a date ("2026-04-30" = midnight UTC) — extend to the end of
  // that UTC day so timed transactions (e.g. TNG rows) on the last day count.
  toDate.setUTCHours(23, 59, 59, 999);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // For a set of transaction ids, fetch allocation rollups in BOTH directions:
  //  inMap[expenseId]   = repayments applied to that expense (offsets the cost)
  //  outMap[repaymentId] = how much of that income row was applied to expenses
  async function getAllocationMaps(txIds: number[]): Promise<{ inMap: Map<number, number>; outMap: Map<number, number> }> {
    const inMap = new Map<number, number>();
    const outMap = new Map<number, number>();
    if (txIds.length === 0) return { inMap, outMap };
    const allocs = await db
      .select({
        repaymentId: reimbursementAllocations.repaymentId,
        expenseId: reimbursementAllocations.expenseId,
        amount: reimbursementAllocations.amount,
      })
      .from(reimbursementAllocations)
      .where(or(inArray(reimbursementAllocations.expenseId, txIds), inArray(reimbursementAllocations.repaymentId, txIds))!);
    for (const a of allocs) {
      const amt = parseFloat(a.amount);
      inMap.set(a.expenseId, (inMap.get(a.expenseId) ?? 0) + amt);
      outMap.set(a.repaymentId, (outMap.get(a.repaymentId) ?? 0) + amt);
    }
    return { inMap, outMap };
  }

  // ── Period transactions (for summary + byCategory) ────────────────────────

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const catMap = new Map(allCats.map((c) => [c.id, c]));

  // Categories flagged as transfers (e.g. "Transfer") hold own-money movements —
  // kept as records, but excluded from income/expense/byCategory/trend totals.
  const transferCatIds = new Set(allCats.filter((c) => c.isTransfer).map((c) => c.id));
  const isTransferTx = (categoryId: number | null) => categoryId != null && transferCatIds.has(categoryId);
  // A repayment's unallocated leftover is re-homed here (income), regardless of the row's own category.
  const otherIncomeCatId = allCats.find((c) => c.role === "other_income")?.id ?? null;

  const periodTx = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, fromDate),
        lte(transactions.postedAt, toDate),
        eq(transactions.isTransfer, false),
        isNull(transactions.deletedAt),
      )
    );

  // Allocation maps first (over ALL rows) so we know which are repayments before filtering.
  const { inMap: reimbInMap, outMap: reimbOutMap } = await getAllocationMaps(periodTx.map((t) => t.id));
  const isRepayment = (id: number) => (reimbOutMap.get(id) ?? 0) > 0.001;
  // Drop transfer-category rows — but keep repayments (their leftover is income).
  const periodSpending = periodTx.filter((t) => !isTransferTx(t.categoryId) || isRepayment(t.id));

  // byCategory: net amounts
  const byCategoryMap = new Map<
    number | null,
    { categoryId: number | null; categoryName: string | null; categoryColor: string | null; total: number; count: number }
  >();
  let totalIncome = 0, totalExpense = 0;

  for (const tx of periodSpending) {
    const net = parseFloat(tx.amount as string) + (reimbInMap.get(tx.id) ?? 0) - (reimbOutMap.get(tx.id) ?? 0);

    if (net > 0) totalIncome += net; else totalExpense += net;

    // A repayment's leftover is bucketed under "Other Income", not the repayment's own category.
    const bucketCatId = isRepayment(tx.id) && otherIncomeCatId != null ? otherIncomeCatId : (tx.categoryId ?? null);
    const existing = byCategoryMap.get(bucketCatId);
    if (existing) {
      existing.total += net;
      existing.count++;
    } else {
      const cat = bucketCatId != null ? catMap.get(bucketCatId) : null;
      byCategoryMap.set(bucketCatId, {
        categoryId: bucketCatId,
        categoryName: cat?.name ?? null,
        categoryColor: cat?.color ?? null,
        total: net,
        count: 1,
      });
    }
  }

  const byCategory = [...byCategoryMap.values()].sort((a, b) => a.total - b.total);

  // ── Monthly trend (last 12 months) ───────────────────────────────────────

  const trendSince = new Date();
  trendSince.setMonth(trendSince.getMonth() - 12);

  const trendTx = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, trendSince),
        eq(transactions.isTransfer, false),
        isNull(transactions.deletedAt),
      )
    );

  const { inMap: trendInMap, outMap: trendOutMap } = await getAllocationMaps(trendTx.map((t) => t.id));
  const trendSpending = trendTx.filter((t) => !isTransferTx(t.categoryId) || (trendOutMap.get(t.id) ?? 0) > 0.001);

  const monthMap = new Map<string, { income: number; expense: number }>();
  for (const tx of trendSpending) {
    const net = parseFloat(tx.amount as string) + (trendInMap.get(tx.id) ?? 0) - (trendOutMap.get(tx.id) ?? 0);
    const month = new Date(tx.postedAt).toISOString().slice(0, 7);
    if (!monthMap.has(month)) monthMap.set(month, { income: 0, expense: 0 });
    const entry = monthMap.get(month)!;
    if (net > 0) entry.income += net; else entry.expense += net;
  }
  const monthlyTrend = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      income: v.income.toFixed(2),
      expense: v.expense.toFixed(2),
    }));

  // ── Uncategorized count ───────────────────────────────────────────────────

  const [{ uncategorized }] = await db
    .select({ uncategorized: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        isNull(transactions.categoryId),
        gte(transactions.postedAt, fromDate),
        lte(transactions.postedAt, toDate),
        isNull(transactions.deletedAt),
      )
    );

  return NextResponse.json({
    period: { from, to },
    summary: {
      totalIncome,
      totalExpense,
      net: totalIncome + totalExpense,
      txCount: periodSpending.length,
      uncategorized: Number(uncategorized),
    },
    byCategory,
    monthlyTrend,
  });
}
