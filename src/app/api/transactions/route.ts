import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { eq, and, gte, lte, sql, desc, isNull, or, ilike } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { computeFingerprint } from "@/lib/parsers/fingerprint";

// Self-join alias to resolve a category's parent name
const parentCat = alias(categories, "parent_cat");
// Self-join alias to resolve the expense a repayment is linked to
const reimbExpense = alias(transactions, "reimb_expense");

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
      reimbursementForId: transactions.reimbursementForId,
      reimbursementForName: sql<string | null>`coalesce(${reimbExpense.merchantNormalized}, ${reimbExpense.description})`,
      notes: transactions.notes,
    })
    .from(transactions)
    .leftJoin(reimbExpense, eq(transactions.reimbursementForId, reimbExpense.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(parentCat, eq(categories.parentId, parentCat.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...rowConditions))
    .orderBy(desc(transactions.postedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(...rowConditions));

  // True income/expense across the WHOLE filtered range. Matches the dashboard:
  //  - excludes transfers and the repayment rows themselves
  //  - NETS each expense by the repayments linked to it (a -100 expense repaid +40 counts as -60)
  //  - ignores the hidden toggle, so figures don't shift when you reveal hidden rows
  const netExpr = sql<number>`(${transactions.amount} + coalesce((
    select sum(r.amount) from ${transactions} r
    where r.reimbursement_for_id = ${transactions.id} and r.deleted_at is null
  ), 0))`;
  const [agg] = await db
    .select({
      income: sql<string>`coalesce(sum(case when ${netExpr} > 0 then ${netExpr} else 0 end), 0)`,
      expense: sql<string>`coalesce(sum(case when ${netExpr} < 0 then ${netExpr} else 0 end), 0)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(
      ...conditions,
      isNull(transactions.reimbursementForId),
      or(isNull(categories.isTransfer), eq(categories.isTransfer, false))!,
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
