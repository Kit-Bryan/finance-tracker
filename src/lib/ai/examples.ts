import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { eq, inArray, isNull, and, desc } from "drizzle-orm";

export interface CategoryExample {
  merchant: string;
  categoryName: string;
}

/**
 * Pull recent user-confirmed categorizations as few-shot examples.
 * These are transactions where categorySource = 'user' or 'rule' (high confidence).
 * De-duped by normalized merchant so we don't flood the prompt.
 */
export async function getConfirmedExamples(limit = 40): Promise<CategoryExample[]> {
  const rows = await db
    .select({
      merchant: transactions.merchantNormalized,
      description: transactions.description,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.categorySource, ["user", "rule"]),
        isNull(transactions.deletedAt)
      )
    )
    .orderBy(desc(transactions.updatedAt))
    .limit(200); // fetch more, then de-dupe

  const allCats = await db.select().from(categories);
  const catById = new Map(allCats.map((c) => [c.id, c.name]));

  // De-dupe by merchant name
  const seen = new Set<string>();
  const examples: CategoryExample[] = [];

  for (const row of rows) {
    const merchant = (row.merchant || row.description).trim();
    const categoryName = row.categoryId ? catById.get(row.categoryId) : null;
    if (!categoryName || !merchant || seen.has(merchant.toLowerCase())) continue;
    seen.add(merchant.toLowerCase());
    examples.push({ merchant, categoryName });
    if (examples.length >= limit) break;
  }

  return examples;
}
