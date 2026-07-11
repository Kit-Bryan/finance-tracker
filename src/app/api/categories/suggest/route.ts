import { NextRequest, NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { getAIClient, DEFAULT_MODEL } from "@/lib/ai/client";
import { getConfirmedExamples } from "@/lib/ai/examples";

export async function POST(req: NextRequest) {
  const { description, hint, amount } = await req.json();

  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
  const examples = await getConfirmedExamples(30);
  const ai = getAIClient();

  const examplesBlock = examples.length > 0
    ? `\nUser's confirmed categorizations (match these for consistency):\n${examples.map((e) => `  "${e.merchant}" → ${e.categoryName}`).join("\n")}\n`
    : "";

  const prompt = `A Malaysian bank transaction needs categorization.

Raw description: "${description}"
${hint ? `User hint: "${hint}"` : ""}
Amount: ${amount < 0 ? "expense" : "income"} MYR ${Math.abs(amount)}

Available categories:
${allCategories.map((c) => c.name).join(", ")}
${examplesBlock}

Based on this, what is the single best category? If the merchant appears in the confirmed examples, use THAT category. If no existing category fits, suggest a new one with an optional parent.

Return ONLY valid JSON (no markdown):
{
  "categoryName": "exact name from the list, or a new name if nothing fits",
  "isNew": false,
  "suggestedParent": "parent category name if isNew is true, otherwise null",
  "confidence": 0.9,
  "reasoning": "one sentence explaining why"
}`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.choices[0]?.message?.content ?? "{}";
  const json = text.replace(/```(?:json)?/g, "").trim();

  try {
    const result = JSON.parse(json);
    // Find category id if it exists
    const existing = allCategories.find(
      (c) => c.name.toLowerCase() === result.categoryName?.toLowerCase()
    );
    return NextResponse.json({
      ...result,
      categoryId: existing?.id ?? null,
      categoryColor: existing?.color ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Parse failed" }, { status: 500 });
  }
}
