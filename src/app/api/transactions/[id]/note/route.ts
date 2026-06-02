import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { transactions, categories } from "@/db/schema";
import { getAIClient, DEFAULT_MODEL } from "@/lib/ai/client";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const txId = parseInt(id);

  const [tx] = await db
    .select({ id: transactions.id, description: transactions.description, merchantNormalized: transactions.merchantNormalized, amount: transactions.amount, categoryId: transactions.categoryId })
    .from(transactions)
    .where(eq(transactions.id, txId));

  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const allCats = await db.select().from(categories);
  const cat = allCats.find((c) => c.id === tx.categoryId);
  const ai = getAIClient();

  const prompt = `Write a very short plain-English note (max 6 words) for this Malaysian bank transaction.
Focus on WHO or WHAT — ignore reference numbers, transaction IDs, and random codes entirely.
If no useful context exists beyond the merchant name, return an empty string.

Raw bank description: "${tx.description}"
Merchant: ${tx.merchantNormalized ?? "unknown"}
Category: ${cat?.name ?? "uncategorized"}
Amount: MYR ${Math.abs(parseFloat(tx.amount as string))} (${parseFloat(tx.amount as string) < 0 ? "expense" : "income"})

Good examples:
- "Meal allowance from Wong Hon Sun"
- "ChatGPT subscription"
- "Transfer from Bryan Wong Win Kit"
- "Haircut at Michael & Guys"
- "" (empty — when there's nothing useful to add beyond merchant name)

Bad examples (never do this):
- "GrabPay payment (ref: xyz123abc)" — don't include refs
- "FPX payment (ref: 2508151328240355)" — don't include refs

Return ONLY the note text or empty string, no quotes, no explanation.`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  const note = resp.choices[0]?.message?.content?.trim() ?? "";

  await db
    .update(transactions)
    .set({ notes: note, updatedAt: new Date() })
    .where(eq(transactions.id, txId));

  return NextResponse.json({ note });
}
