import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { flags, transactions } from "@/db/schema";
import { learnMerchant } from "@/lib/categorizer/rules";

// POST /api/flags/[id]/resolve
//  - reimbursement: links the candidate transfers to the expense (body optional: { reimbursementIds })
//  - low_confidence: sets the category (body required: { categoryId })
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const flagId = parseInt(id);
  const body = await req.json().catch(() => ({}));

  const [flag] = await db.select().from(flags).where(eq(flags.id, flagId));
  if (!flag) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (flag.type === "reimbursement") {
    const data = (flag.data ?? {}) as { reimbursementIds?: number[] };
    const ids: number[] = body.reimbursementIds ?? data.reimbursementIds ?? [];
    if (ids.length > 0) {
      await db
        .update(transactions)
        .set({ reimbursementForId: flag.transactionId, updatedAt: new Date() })
        .where(inArray(transactions.id, ids));
    }
    await db.update(flags).set({ status: "resolved", updatedAt: new Date() }).where(eq(flags.id, flagId));
    return NextResponse.json({ ok: true, linked: ids.length });
  }

  if (flag.type === "low_confidence") {
    const { categoryId } = body as { categoryId?: number };
    if (categoryId == null) {
      return NextResponse.json({ error: "categoryId required" }, { status: 400 });
    }
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, flag.transactionId));
    if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });

    await db
      .update(transactions)
      .set({ categoryId, categorySource: "user", categoryConfidence: "1", updatedAt: new Date() })
      .where(eq(transactions.id, flag.transactionId));
    await learnMerchant(tx.description, categoryId, "user");

    await db.update(flags).set({ status: "resolved", updatedAt: new Date() }).where(eq(flags.id, flagId));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown flag type" }, { status: 400 });
}
