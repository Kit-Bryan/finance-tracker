import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, transactions } from "@/db/schema";
import { isNull, sql } from "drizzle-orm";

// GET /api/categories/manage — categories with per-category usage stats (live transactions only)
export async function GET() {
  const cats = await db
    .select()
    .from(categories)
    .where(isNull(categories.deletedAt))
    .orderBy(categories.name);

  const stats = await db
    .select({
      categoryId: transactions.categoryId,
      count: sql<number>`count(*)`,
      total: sql<string>`sum(${transactions.amount})`,
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
        txCount: s ? Number(s.count) : 0,
        total: s ? parseFloat(s.total ?? "0") : 0,
      };
    })
  );
}
