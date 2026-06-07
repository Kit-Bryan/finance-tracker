import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { pruneOrphanMerchants } from "@/lib/categorizer/rules";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "transactions/split" });

// POST { splits: [{ amount, description, notes?, categoryId? }] }
// Soft-deletes the original and creates the split children. Amounts are signed and
// must sum to the original (±0.02). Mirrors the AI agent's split behavior.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [original] = await db.select().from(transactions).where(eq(transactions.id, txId));
  if (!original || original.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { splits } = await req.json() as {
    splits: { amount: number; description: string; notes?: string; categoryId?: number | null }[];
  };
  if (!Array.isArray(splits) || splits.length < 2) {
    return NextResponse.json({ error: "Provide at least two splits" }, { status: 400 });
  }
  for (const s of splits) {
    if (!s.description?.trim()) return NextResponse.json({ error: "Each split needs a description" }, { status: 400 });
    if (typeof s.amount !== "number" || Number.isNaN(s.amount)) return NextResponse.json({ error: "Each split needs an amount" }, { status: 400 });
  }

  const originalAmount = parseFloat(original.amount as string);
  const splitTotal = splits.reduce((s, r) => s + r.amount, 0);
  if (Math.abs(splitTotal - originalAmount) > 0.02) {
    return NextResponse.json(
      { error: `Split amounts (${splitTotal.toFixed(2)}) must sum to the original (${originalAmount.toFixed(2)}).` },
      { status: 400 }
    );
  }

  let inserted = 0;
  await db.transaction(async (txn) => {
    await txn.update(transactions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(transactions.id, txId));
    for (const s of splits) {
      const fingerprint = createHash("sha256")
        .update(`split:${original.fingerprint}:${s.amount}:${s.description}:${inserted}`)
        .digest("hex").slice(0, 64);
      await txn.insert(transactions).values({
        accountId: original.accountId,
        batchId: original.batchId,
        categoryId: s.categoryId ?? original.categoryId,
        postedAt: original.postedAt,
        amount: String(s.amount),
        currency: original.currency,
        description: s.description,
        merchantNormalized: s.description,
        notes: s.notes ?? null,
        fingerprint,
        categorySource: s.categoryId ? "user" : original.categorySource,
        categoryConfidence: "1",
      });
      inserted++;
    }
  });

  await pruneOrphanMerchants([original.description]);
  log.info({ originalId: txId, count: inserted }, "transaction split");
  return NextResponse.json({ ok: true, count: inserted });
}
