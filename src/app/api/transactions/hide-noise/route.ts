import { NextResponse } from "next/server";
import { and, isNull, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { isGoPlusNoise } from "@/lib/categorizer/rules";
import { logger } from "@/lib/logger";

// POST /api/transactions/hide-noise
// Retroactively hide GO+ internal "plumbing" legs that were imported before
// auto-hide existed. Idempotent — only touches currently-visible matches.
export async function POST() {
  const log = logger.child({ route: "transactions/hide-noise" });

  const rows = await db
    .select({ id: transactions.id, description: transactions.description })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.hidden, false)));

  const ids = rows.filter((r) => isGoPlusNoise(r.description)).map((r) => r.id);
  if (ids.length === 0) return NextResponse.json({ hidden: 0 });

  await db.update(transactions).set({ hidden: true, updatedAt: new Date() }).where(inArray(transactions.id, ids));
  log.info({ hidden: ids.length }, "bulk-hid GO+ internal legs");
  return NextResponse.json({ hidden: ids.length });
}
