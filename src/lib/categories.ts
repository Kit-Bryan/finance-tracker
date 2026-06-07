import { db } from "@/db";
import { categories, transactions } from "@/db/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";

// ─── System (mandatory) categories ───────────────────────────────────────────
// Bound to a role so code references them by function, not by a renamable/deletable
// name. A category with a non-null role cannot be deleted.
export const SYSTEM_CATEGORIES = [
  { role: "income", name: "Income", color: "#22c55e", isTransfer: false, parentRole: null },
  { role: "transfer", name: "Transfer", color: "#94a3b8", isTransfer: true, parentRole: null },
  { role: "uncategorized", name: "Uncategorized", color: "#d1d5db", isTransfer: false, parentRole: null },
  // Home for the unallocated leftover of a repayment (a sub-category under Income).
  { role: "other_income", name: "Other Income", color: "#22c55e", isTransfer: false, parentRole: "income" },
] as const;

export type SystemRole = (typeof SYSTEM_CATEGORIES)[number]["role"];

/**
 * Ensure each mandatory system category exists and is tagged with its role.
 * Idempotent: adopts an existing same-named category if present, otherwise creates it.
 * Processed in array order so parents exist before their role-bound children.
 * Safe to run repeatedly (e.g. after db:push or on seed).
 */
export async function ensureSystemCategories(): Promise<void> {
  for (const sc of SYSTEM_CATEGORIES) {
    const [byRole] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.role, sc.role), isNull(categories.deletedAt)));
    if (byRole) continue;

    const live = await db.select().from(categories).where(isNull(categories.deletedAt));
    const match = live.find((c) => c.name.toLowerCase() === sc.name.toLowerCase());
    if (match) {
      await db
        .update(categories)
        .set({ role: sc.role, ...(sc.isTransfer ? { isTransfer: true } : {}) })
        .where(eq(categories.id, match.id));
      continue;
    }

    let parentId: number | null = null;
    if (sc.parentRole) {
      const [parent] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.role, sc.parentRole), isNull(categories.deletedAt)));
      parentId = parent?.id ?? null;
    }

    await db.insert(categories).values({
      name: sc.name,
      color: sc.color,
      parentId,
      isTransfer: sc.isTransfer,
      role: sc.role,
    });
  }
}

/** Resolve the live category id for a system role (null if somehow absent). */
export async function getSystemCategoryId(role: SystemRole): Promise<number | null> {
  const [c] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.role, role), isNull(categories.deletedAt)));
  return c?.id ?? null;
}

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
