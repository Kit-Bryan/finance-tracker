import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { sql, eq, and, gte, lte, lt, gt } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const to = searchParams.get("to") ?? new Date().toISOString();

  const fromDate = new Date(from);
  const toDate = new Date(to);

  // Monthly totals by category
  const byCategory = await db
    .select({
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      total: sql<string>`sum(${transactions.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        gte(transactions.postedAt, fromDate),
        lte(transactions.postedAt, toDate),
        eq(transactions.isTransfer, false)
      )
    )
    .groupBy(transactions.categoryId, categories.name, categories.color)
    .orderBy(sql`sum(${transactions.amount})`);

  // Total income vs expense
  const [summary] = await db
    .select({
      totalIncome: sql<string>`sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end)`,
      totalExpense: sql<string>`sum(case when ${transactions.amount} < 0 then ${transactions.amount} else 0 end)`,
      txCount: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, fromDate),
        lte(transactions.postedAt, toDate),
        eq(transactions.isTransfer, false)
      )
    );

  // Monthly trend (last 12 months)
  const monthlyTrend = await db
    .select({
      month: sql<string>`to_char(${transactions.postedAt}, 'YYYY-MM')`,
      income: sql<string>`sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end)`,
      expense: sql<string>`sum(case when ${transactions.amount} < 0 then ${transactions.amount} else 0 end)`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, new Date(new Date().setMonth(new Date().getMonth() - 12))),
        eq(transactions.isTransfer, false)
      )
    )
    .groupBy(sql`to_char(${transactions.postedAt}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${transactions.postedAt}, 'YYYY-MM')`);

  // Uncategorized count
  const [{ uncategorized }] = await db
    .select({ uncategorized: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        sql`${transactions.categoryId} is null`,
        gte(transactions.postedAt, fromDate),
        lte(transactions.postedAt, toDate)
      )
    );

  return NextResponse.json({
    period: { from, to },
    summary: {
      totalIncome: parseFloat(summary?.totalIncome ?? "0"),
      totalExpense: parseFloat(summary?.totalExpense ?? "0"),
      net: parseFloat(summary?.totalIncome ?? "0") + parseFloat(summary?.totalExpense ?? "0"),
      txCount: summary?.txCount ?? 0,
      uncategorized: Number(uncategorized),
    },
    byCategory: byCategory.map((r) => ({
      ...r,
      total: parseFloat(r.total ?? "0"),
    })),
    monthlyTrend,
  });
}
