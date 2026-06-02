import { NextRequest, NextResponse } from "next/server";
import { eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { bulkCategorize } from "@/lib/ai/categorize";
import { learnMerchant } from "@/lib/categorizer/rules";

// POST body: { transactionIds?: number[] }
// If transactionIds omitted → categorize ALL uncategorized transactions
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { transactionIds } = body as { transactionIds?: number[] };

  // Load categories
  const allCategories = await db.select().from(categories);
  const categoryNames = allCategories.map((c) => c.name);
  const categoryByName = new Map(allCategories.map((c) => [c.name.toLowerCase(), c]));

  // Load target transactions
  let rows;
  if (transactionIds?.length) {
    rows = await db.select().from(transactions).where(inArray(transactions.id, transactionIds));
  } else {
    rows = await db.select().from(transactions).where(isNull(transactions.categoryId));
  }

  if (rows.length === 0) return NextResponse.json({ updated: 0 });

  // Batch in chunks of 50 to stay within token limits
  const CHUNK = 50;
  let updated = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const inputs = chunk.map((r) => ({
      id: r.id,
      description: r.description,
      amount: parseFloat(r.amount as string),
    }));

    const results = await bulkCategorize(inputs, categoryNames);

    for (const result of results) {
      const cat = categoryByName.get(result.categoryName.toLowerCase());
      if (!cat) continue;

      await db
        .update(transactions)
        .set({
          categoryId: cat.id,
          merchantNormalized: result.merchantName,
          categorySource: "agent",
          categoryConfidence: String(Math.min(1, Math.max(0, result.confidence))),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, result.id));

      // Learn merchant for future rule-free imports
      const tx = chunk.find((r) => r.id === result.id);
      if (tx) await learnMerchant(tx.description, cat.id, "agent");

      updated++;
    }
  }

  return NextResponse.json({ updated, total: rows.length });
}
