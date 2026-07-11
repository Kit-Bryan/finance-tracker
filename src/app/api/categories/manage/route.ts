import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, transactions, reimbursementAllocations } from "@/db/schema";
import { isNull, sql } from "drizzle-orm";

// Live financial data — never serve a cached response (this route takes no params,
// so Next would otherwise cache it and show stale category totals).
export const dynamic = "force-dynamic";

// GET /api/categories/manage — categories with per-category usage stats (live transactions only)
export async function GET() {
  const cats = await db
    .select()
    .from(categories)
    .where(isNull(categories.deletedAt))
    .orderBy(categories.name);

  // total is NET of reimbursement allocations, matching the dashboard: repayments
  // applied to an expense offset its cost (so a fully-refunded purchase nets to 0
  // and doesn't inflate its category), and a repayment's applied portion is removed.
  const stats = await db
    .select({
      categoryId: transactions.categoryId,
      count: sql<number>`count(*)`,
      // NOTE: correlation columns are written as literal "transactions.id" — drizzle
      // renders ${transactions.id} as bare "id", which inside the subquery would bind
      // to reimbursement_allocations.id instead of the outer row.
      total: sql<string>`sum(
        ${transactions.amount}
        + coalesce((select sum(a.amount) from ${reimbursementAllocations} a where a.expense_id = transactions.id), 0)
        - coalesce((select sum(a.amount) from ${reimbursementAllocations} a where a.repayment_id = transactions.id), 0)
      )`,
    })
    .from(transactions)
    .where(isNull(transactions.deletedAt))
    .groupBy(transactions.categoryId);

  const statById = new Map(stats.map((s) => [s.categoryId, s]));

  return NextResponse.json(
    cats.map((c) => {
      const s = statById.get(c.id);
      return {
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        color: c.color,
        isTransfer: c.isTransfer ?? false,
        role: c.role ?? null,
        txCount: s ? Number(s.count) : 0,
        total: s ? parseFloat(s.total ?? "0") : 0,
      };
    })
  );
}
