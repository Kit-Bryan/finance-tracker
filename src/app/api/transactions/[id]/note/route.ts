import { NextRequest, NextResponse } from "next/server";
import { eq, isNull } from "drizzle-orm";
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

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const cat = allCats.find((c) => c.id === tx.categoryId);
  const ai = getAIClient();

  const prompt = `Write a concise plain-English note (6–10 words) for this Malaysian bank transaction.
Your goal is to extract the most useful human-readable context from the raw description — especially
any remarks, names, purposes, or references to what the money was for.
Ignore transaction IDs, reference numbers, and random alphanumeric codes entirely.
If the raw description contains no useful context beyond the merchant name, return an empty string.

Raw bank description: "${tx.description}"
Merchant: ${tx.merchantNormalized ?? "unknown"}
Category: ${cat?.name ?? "uncategorized"}
Amount: MYR ${Math.abs(parseFloat(tx.amount as string))} (${parseFloat(tx.amount as string) < 0 ? "expense" : "income"})

Good examples (extract the meaningful remark, name, or purpose):
- "Meal allowance from Wong Hon Sun"
- "ChatGPT Plus monthly subscription"
- "Transfer from Bryan Wong Win Kit"
- "Haircut at Michael & Guys 1 Utama"
- "Salary advance for June"
- "Payment for Mayflour group meal"
- "Grab food delivery order"
- "" (empty — when there's nothing useful to add beyond the merchant name)

Bad examples (never do this):
- "GrabPay payment (ref: xyz123abc)" — don't include refs/codes
- "FPX payment (ref: 2508151328240355)" — don't include refs/codes
- "Transaction at Shopee" — too generic, just return empty

Touch 'n Go GO+ direction (commonly misread — get this right):
- "Quick Reload Payment (via GO+ Balance)" = GO+ → eWallet (funds a payment). Note: "Funded from GO+ balance"
- "eWallet Cash Out" / "Via eWallet to GO+" = eWallet → GO+. Note: "Moved to GO+ balance"

Return ONLY the note text or an empty string. No quotes, no explanation.`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  const note = resp.choices[0]?.message?.content?.trim() ?? "";

  await db
    .update(transactions)
    .set({ notes: note, updatedAt: new Date() })
    .where(eq(transactions.id, txId));

  return NextResponse.json({ note });
}
