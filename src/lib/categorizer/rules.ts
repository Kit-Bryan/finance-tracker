import { db } from "@/db";
import { categorizationRules, merchants, transactions } from "@/db/schema";
import { eq, desc, and, isNull, inArray } from "drizzle-orm";

export interface CategoryResult {
  categoryId: number | null;
  source: "rule" | "merchant" | "none";
  confidence: number;
  ruleId?: number;
}

export function normalizeMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/\s+\d+$/, "")        // trailing numbers (branch codes)
    .replace(/\*[^*]*$/, "")       // VISA * suffix
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function categorizeByRules(description: string): Promise<CategoryResult> {
  const rules = await db
    .select()
    .from(categorizationRules)
    .where(eq(categorizationRules.enabled, true))
    .orderBy(desc(categorizationRules.priority));

  for (const rule of rules) {
    let match = false;
    const lower = description.toLowerCase();
    const pattern = rule.pattern.toLowerCase();

    if (rule.patternType === "contains") {
      match = lower.includes(pattern);
    } else if (rule.patternType === "startsWith") {
      match = lower.startsWith(pattern);
    } else if (rule.patternType === "regex") {
      try {
        match = new RegExp(rule.pattern, "i").test(description);
      } catch {
        match = false;
      }
    }

    if (match) {
      await db
        .update(categorizationRules)
        .set({ matchCount: (rule.matchCount ?? 0) + 1 })
        .where(eq(categorizationRules.id, rule.id));

      return {
        categoryId: rule.categoryId,
        source: "rule",
        confidence: 1.0,
        ruleId: rule.id,
      };
    }
  }

  // Fall back to merchant memory
  const normalized = normalizeMerchant(description);
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.normalizedName, normalized));

  if (merchant?.categoryId) {
    return {
      categoryId: merchant.categoryId,
      source: "merchant",
      confidence: 0.9,
    };
  }

  return { categoryId: null, source: "none", confidence: 0 };
}

/**
 * Forget merchant-memory entries for the given (now-deleted) transaction descriptions,
 * but ONLY when no live (non-deleted) transaction still maps to that normalized merchant.
 * This keeps memory from being influenced by deleted data without forgetting merchants
 * that are still in active use.
 */
export async function pruneOrphanMerchants(descriptions: string[]) {
  const targets = new Set(descriptions.map(normalizeMerchant).filter(Boolean));
  if (targets.size === 0) return;

  const live = await db
    .select({ description: transactions.description })
    .from(transactions)
    .where(isNull(transactions.deletedAt));
  const liveNorms = new Set(live.map((t) => normalizeMerchant(t.description)));

  const orphans = [...targets].filter((n) => !liveNorms.has(n));
  if (orphans.length === 0) return;

  await db.delete(merchants).where(inArray(merchants.normalizedName, orphans));
}

export async function learnMerchant(
  description: string,
  categoryId: number,
  source: "user" | "rule" | "agent" = "user"
) {
  const normalized = normalizeMerchant(description);
  if (!normalized) return;

  const [existing] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.normalizedName, normalized));

  if (existing) {
    await db
      .update(merchants)
      .set({
        categoryId,
        source,
        useCount: (existing.useCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(merchants.id, existing.id));
  } else {
    await db.insert(merchants).values({
      normalizedName: normalized,
      displayName: description.trim(),
      categoryId,
      source,
    });
  }
}
