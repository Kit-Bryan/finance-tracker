import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { eq, inArray, isNull, and, desc, sql } from "drizzle-orm";
import { normalizeMerchant, isGenericMerchant } from "@/lib/categorizer/rules";

export interface CategoryExample {
  merchant: string;
  categoryName: string;
}

export interface NoteExample {
  description: string;
  note: string;
}

/**
 * Recent transactions that HAVE notes, as description→note pairs (deduped by
 * merchant). Fed to the AI so new notes match the user's established phrasing
 * and reuse recurring context ("Meal allowance from Wong Hon Sun" etc.).
 */
export async function getNoteExamples(limit = 15): Promise<NoteExample[]> {
  const rows = await db
    .select({
      description: transactions.description,
      merchant: transactions.merchantNormalized,
      notes: transactions.notes,
    })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), sql`coalesce(${transactions.notes}, '') <> ''`))
    .orderBy(desc(transactions.updatedAt))
    .limit(120);

  const seen = new Set<string>();
  const out: NoteExample[] = [];
  for (const r of rows) {
    const key = (r.merchant || r.description).trim().toLowerCase();
    if (!key || seen.has(key) || !r.notes?.trim()) continue;
    seen.add(key);
    out.push({ description: r.description, note: r.notes.trim() });
    if (out.length >= limit) break;
  }
  return out;
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

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const catById = new Map(allCats.map((c) => [c.id, c.name]));

  // De-dupe by merchant name
  const seen = new Set<string>();
  const examples: CategoryExample[] = [];

  for (const row of rows) {
    const merchant = (row.merchant || row.description).trim();
    const categoryName = row.categoryId ? catById.get(row.categoryId) : null;
    if (!categoryName || !merchant || seen.has(merchant.toLowerCase())) continue;
    // Person-to-person transfers and multi-purpose wallets make POISONOUS
    // examples: "Wong Hon Sun → Car Purchase" teaches the model to stamp that
    // category on every future transfer to that person, regardless of what the
    // remark says. Only stable business merchants belong in the examples.
    if (isGenericMerchant(normalizeMerchant(row.description)) || isGenericMerchant(normalizeMerchant(merchant))) continue;
    seen.add(merchant.toLowerCase());
    examples.push({ merchant, categoryName });
    if (examples.length >= limit) break;
  }

  return examples;
}
