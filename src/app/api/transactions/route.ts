import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts, reimbursementAllocations, importBatches } from "@/db/schema";
import { eq, and, gte, lte, sql, desc, isNull, or, ilike } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { computeFingerprint } from "@/lib/parsers/fingerprint";

// Self-join alias to resolve a category's parent name
const parentCat = alias(categories, "parent_cat");

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(200, parseInt(searchParams.get("limit") ?? "50"));
  const offset = (page - 1) * limit;
  const accountId = searchParams.get("accountId");
  const categoryId = searchParams.get("categoryId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const search = searchParams.get("search")?.trim();
  const includeHidden = searchParams.get("includeHidden") === "1";

  const conditions = [isNull(transactions.deletedAt)];
  if (accountId) conditions.push(eq(transactions.accountId, parseInt(accountId)));
  if (categoryId === "none") conditions.push(isNull(transactions.categoryId));
  else if (categoryId) conditions.push(eq(transactions.categoryId, parseInt(categoryId)));
  if (from) conditions.push(gte(transactions.postedAt, new Date(from)));
  if (to) {
    const toEnd = new Date(to);
    toEnd.setHours(23, 59, 59, 999);
    conditions.push(lte(transactions.postedAt, toEnd));
  }
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(transactions.description, pattern),
        ilike(transactions.merchantNormalized, pattern),
        ilike(transactions.notes, pattern),
      )!
    );
  }

  // The visible list respects the hidden toggle; the totals below ignore it so they stay stable.
  const rowConditions = includeHidden ? conditions : [...conditions, eq(transactions.hidden, false)];

  const rows = await db
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
      parentCategoryName: parentCat.name,
      accountId: transactions.accountId,
      accountName: accounts.name,
      isTransfer: transactions.isTransfer,
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
      hidden: transactions.hidden,
      // Allocation rollups (many-to-many repayments):
      //  allocatedIn  = repayments applied TO this expense (positive)
      //  allocatedOut = how much of this (income) row is applied to expenses
      allocatedIn: sql<string>`(select coalesce(sum(a.amount), 0) from ${reimbursementAllocations} a where a.expense_id = ${transactions.id})`,
      allocatedOut: sql<string>`(select coalesce(sum(a.amount), 0) from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id})`,
      allocationCount: sql<number>`(select count(*)::int from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id})`,
      primaryTargetName: sql<string | null>`(
        select coalesce(e.merchant_normalized, e.description)
        from ${reimbursementAllocations} a join ${transactions} e on e.id = a.expense_id
        where a.repayment_id = ${transactions.id} order by a.id limit 1
      )`,
      notes: transactions.notes,
      // Source trace-back: which import batch this came from, whether its
      // original file is stored, and where on the document this row sits.
      batchId: transactions.batchId,
      batchStoredFile: importBatches.storedFile,
      sourcePage: sql<number | null>`(${transactions.rawRow}->>'page')::int`,
      sourceYPercent: sql<number | null>`(${transactions.rawRow}->>'yPercent')::float`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(parentCat, eq(categories.parentId, parentCat.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(importBatches, eq(transactions.batchId, importBatches.id))
    .where(and(...rowConditions))
    .orderBy(desc(transactions.postedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(...rowConditions));

  // True income/expense across the WHOLE filtered range. Matches the dashboard:
  //  - excludes transfers
  //  - one unified net per row: amount + repayments received (as an expense)
  //    − amount applied out (as a repayment). So a −100 expense repaid +40 nets to −60,
  //    a fully-allocated repayment nets to 0, and a rounded-up repayment's leftover counts as income.
  //  - ignores the hidden toggle, so figures don't shift when you reveal hidden rows
  const netExpr = sql<number>`(
    ${transactions.amount}
    + coalesce((select sum(a.amount) from ${reimbursementAllocations} a where a.expense_id = ${transactions.id}), 0)
    - coalesce((select sum(a.amount) from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id}), 0)
  )`;
  const [agg] = await db
    .select({
      income: sql<string>`coalesce(sum(case when ${netExpr} > 0 then ${netExpr} else 0 end), 0)`,
      expense: sql<string>`coalesce(sum(case when ${netExpr} < 0 then ${netExpr} else 0 end), 0)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(
      ...conditions,
      // Exclude transfers — EXCEPT a repayment row (one with outgoing allocations), whose
      // unallocated leftover is real income and must count regardless of its category.
      or(
        isNull(categories.isTransfer),
        eq(categories.isTransfer, false),
        sql`(select coalesce(sum(a.amount), 0) from ${reimbursementAllocations} a where a.repayment_id = ${transactions.id}) > 0`,
      )!,
    ));

  return NextResponse.json({
    rows,
    total: Number(count),
    page,
    limit,
    totalIncome: parseFloat(agg.income),
    totalExpense: parseFloat(agg.expense),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { accountId, description, amount, postedAt, categoryId, notes, currency } = body;

  if (!accountId || !description || amount === undefined || !postedAt) {
    return NextResponse.json({ error: "accountId, description, amount, postedAt are required" }, { status: 400 });
  }

  const date = new Date(postedAt);
  const fingerprint = computeFingerprint(accountId, date, amount, description);

  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      description,
      amount: String(amount),
      postedAt: date,
      currency: currency ?? "MYR",
      fingerprint,
      categoryId: categoryId ?? null,
      categorySource: categoryId ? "user" : null,
      notes: notes ?? null,
    })
    .onConflictDoNothing()
    .returning();

  return NextResponse.json(row, { status: 201 });
}
