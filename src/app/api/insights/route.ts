import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { sql, eq, and, gte, lte, isNull, inArray } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const to = searchParams.get("to") ?? new Date().toISOString();

  const fromDate = new Date(from);
  const toDate = new Date(to);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Fetch reimbursement totals for a set of expense transaction IDs
  async function getReimbursementMap(txIds: number[]): Promise<Map<number, number>> {
    if (txIds.length === 0) return new Map();
    const rows = await db
      .select({
        forId: transactions.reimbursementForId,
        total: sql<string>`sum(${transactions.amount})`,
      })
      .from(transactions)
      .where(and(inArray(transactions.reimbursementForId as any, txIds), isNull(transactions.deletedAt)))
      .groupBy(transactions.reimbursementForId);
    const map = new Map<number, number>();
    for (const r of rows) {
      if (r.forId != null) map.set(r.forId, parseFloat(r.total ?? "0"));
    }
    return map;
  }

  // ── Period transactions (for summary + byCategory) ────────────────────────

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const catMap = new Map(allCats.map((c) => [c.id, c]));

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
        isNull(transactions.reimbursementForId), // exclude reimbursement transfers themselves
      )
    );

  const reimbMap = await getReimbursementMap(periodTx.map((t) => t.id));

  // byCategory: net amounts
  const byCategoryMap = new Map<
    number | null,
    { categoryId: number | null; categoryName: string | null; categoryColor: string | null; total: number; count: number }
  >();
  let totalIncome = 0, totalExpense = 0;

  for (const tx of periodTx) {
    const reimbursed = reimbMap.get(tx.id) ?? 0;
    const net = parseFloat(tx.amount as string) + reimbursed;

    if (net > 0) totalIncome += net; else totalExpense += net;

    const existing = byCategoryMap.get(tx.categoryId ?? null);
    if (existing) {
      existing.total += net;
      existing.count++;
    } else {
      const cat = tx.categoryId ? catMap.get(tx.categoryId) : null;
      byCategoryMap.set(tx.categoryId ?? null, {
        categoryId: tx.categoryId ?? null,
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
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, trendSince),
        eq(transactions.isTransfer, false),
        isNull(transactions.deletedAt),
        isNull(transactions.reimbursementForId),
      )
    );

  const trendReimbMap = await getReimbursementMap(trendTx.map((t) => t.id));

  const monthMap = new Map<string, { income: number; expense: number }>();
  for (const tx of trendTx) {
    const reimbursed = trendReimbMap.get(tx.id) ?? 0;
    const net = parseFloat(tx.amount as string) + reimbursed;
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
        isNull(transactions.reimbursementForId),
      )
    );

  return NextResponse.json({
    period: { from, to },
    summary: {
      totalIncome,
      totalExpense,
      net: totalIncome + totalExpense,
      txCount: periodTx.length,
      uncategorized: Number(uncategorized),
    },
    byCategory,
    monthlyTrend,
  });
}
