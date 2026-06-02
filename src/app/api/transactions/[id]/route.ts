import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { learnMerchant } from "@/lib/categorizer/rules";
import { eq } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = parseInt(params.id);
  const body = await req.json();
  const { categoryId, notes } = body;

  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));

  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .update(transactions)
    .set({
      ...(categoryId !== undefined ? { categoryId, categorySource: "user", categoryConfidence: "1" } : {}),
      ...(notes !== undefined ? { notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, id));

  // Learn from user correction
  if (categoryId !== undefined && tx.description) {
    await learnMerchant(tx.description, categoryId, "user");
  }

  return NextResponse.json({ ok: true });
}
