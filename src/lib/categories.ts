import { db } from "@/db";
import { categories, transactions } from "@/db/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";

/** A category id plus the ids of its non-deleted children. */
export async function getFamilyIds(id: number): Promise<number[]> {
  const kids = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.parentId, id), isNull(categories.deletedAt)));
  return [id, ...kids.map((k) => k.id)];
}

/** Count live (non-deleted) transactions assigned to any of the given category ids. */
export async function countTransactionsFor(catIds: number[]): Promise<number> {
  if (catIds.length === 0) return 0;
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(and(inArray(transactions.categoryId, catIds), isNull(transactions.deletedAt)));
  return Number(c);
}

/**
 * Merge a source category (and its children) into a target:
 * reassign every live transaction to the target, then soft-delete the source family.
 * Powers both the explicit "merge" feature and the "resolve transactions then delete" flow.
 */
export async function mergeCategories(sourceId: number, targetId: number): Promise<{ reassigned: number }> {
  const family = await getFamilyIds(sourceId);
  if (family.includes(targetId)) {
    throw new Error("Cannot merge a category into itself or one of its children");
  }

  const reassigned = await db
    .update(transactions)
    .set({ categoryId: targetId, categorySource: "user", categoryConfidence: "1", updatedAt: new Date() })
    .where(inArray(transactions.categoryId, family))
    .returning({ id: transactions.id });

  await db
    .update(categories)
    .set({ deletedAt: new Date() })
    .where(inArray(categories.id, family));

  return { reassigned: reassigned.length };
}
