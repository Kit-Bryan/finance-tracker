import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { eq, and, gte, lte, sql, desc, isNull } from "drizzle-orm";
import { computeFingerprint } from "@/lib/parsers/fingerprint";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(200, parseInt(searchParams.get("limit") ?? "50"));
  const offset = (page - 1) * limit;
  const accountId = searchParams.get("accountId");
  const categoryId = searchParams.get("categoryId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const conditions = [isNull(transactions.deletedAt)];
  if (accountId) conditions.push(eq(transactions.accountId, parseInt(accountId)));
  if (categoryId) conditions.push(eq(transactions.categoryId, parseInt(categoryId)));
  if (from) conditions.push(gte(transactions.postedAt, new Date(from)));
  if (to) conditions.push(lte(transactions.postedAt, new Date(to)));

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
      accountId: transactions.accountId,
      accountName: accounts.name,
      isTransfer: transactions.isTransfer,
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
      notes: transactions.notes,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactions.postedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return NextResponse.json({ rows, total: Number(count), page, limit });
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
